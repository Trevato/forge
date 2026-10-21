# Caching: the map and home

What `/map` and `/` cache, what each entry is keyed by, which writes make
it stale, and how old it may get. Written before any of it is built
(#2715). #2716 builds the map half, #2717 the home half, and #2718 does
ETag/immutable for static assets, which this doc does not cover. A cache
that is not described here is a bug. So is a write that changes a cached
answer and is missing from the tables below.

## The rules every entry here keeps

1. **Access is never cached.** Which repositories a viewer may read
   (`listReposVisibleTo`), whether they may see sealed issues
   (`sealedScope`), and whether they are an admin are worked out on every
   request, before any cache is read. Then that answer goes into the key.
   A grant, a team change, a suspension or a visibility flip changes the
   next request's key. There is nothing to invalidate, so no event can
   arrive too late and no listener can be forgotten.
2. **The key carries what the viewer may see.** Two viewers share an entry
   only when their access computes to the same scope. One person's sealed
   report, private repository or spend never reaches another person's
   page through a shared entry.
3. **Data is cached, not finished HTML.** Entries hold ids, numbers,
   positions and rows. The page is still rendered for each request, so
   escaping, the CSP nonce, relative times ("3 min ago") and the viewer's
   own name are always the current request's.
4. **Validated, not trusted.** An entry is used only after its key's
   *head* has been read from the database again: the repository's latest
   event (`MAX(event.seq)`, from the `event_repo_seq` index). That works
   across processes. During a roll, two processes write to one database
   (#875), and the in-process bus (`core/events.ts`) cannot wake the other
   process's listeners. The sequence still moves, so the bus is only a way
   to evict early, never the thing correctness depends on.
5. **Everything is droppable.** Git is the truth and the database is
   derived from it (CLAUDE.md, invariant 4). A cache sits one step further
   from the truth than that. Each cache is a per-process `Map` with an
   entry cap, LRU like `src/view/cache.ts`. A restart, an eviction or a
   miss costs one rebuild and is never wrong.
6. **A cache does not hide a per-row query.** The N+1 reads named under
   "Where the time goes" get fixed (grouped helpers, the CLAUDE.md recipe)
   whether or not a cache is put in front of them. Otherwise a cold miss
   and the first view after every write stay slow, and
   `test/counts.test.ts` stays right to complain.

## Today's numbers

`bun run bench/map-home.ts` seeds a fixture shaped like this forge as the
API reported it on 2026-10-19:

- 69 repositories.
- One repository with 2,700 issues: 213 open, 20 open pulls, 3 sealed, and
  5 agent runs in flight. Its graph is 926 issues and 1,699 edges (the real
  `trevato/forge` map: 926 / 1,699).
- Nine more plans with 68, 48, 38, 33, 30, 27, 2, 1 and 1 open issues. Two
  of them are private to the owner.
- 60,000 outbox events.

The bench then times each case 30 times over HTTP, after one warm hit.
The SQL counter is `bench/run.ts`'s `countStatements`, which counts every
statement that runs, not every statement that is prepared.

- **owner**: the site admin who owns every plan.
- **stranger**: a signed-in account with no grant anywhere.
- **anonymous**: no session at all. `/map` sends an anonymous visitor to
  sign in; `/` shows them the door.

Measured on an 80-thread Xeon Gold 6230 (shared), Bun 1.3.14, with no cache
anywhere:

| request             | p50 ms | p95 ms | SQL / request |   bytes |
| ------------------- | -----: | -----: | ------------: | ------: |
| `GET /map` owner    |  810.6 |  854.4 |        2684.7 | 1046463 |
| `GET /map` stranger |  766.1 |  805.3 |        2636.7 | 1034267 |
| `GET /map` anonymous |   0.3 |    0.4 |             0 |   (303) |
| `GET /` owner       |   92.0 |   96.6 |        1974.3 |  103473 |
| `GET /` stranger    |   70.6 |   75.5 |        1784.2 |   88149 |
| `GET /` anonymous   |    1.5 |    2.9 |          10.0 |   14369 |

The machine is shared, so latency varies from run to run: an earlier run of
20 hits gave `/map` p50 527 / 491 ms and `/` p50 98 / 80 ms. The SQL counts
were the same in both runs. Treat latency as an order of magnitude and the
statement count as the exact figure.

After #2716 (same fixture, same machine, `--n 30`, warm; `/` unchanged):

| request             | p50 ms | p95 ms | SQL / request |
| ------------------- | -----: | -----: | ------------: |
| `GET /map` owner    |   26.7 |   34.5 |          25.0 |
| `GET /map` stranger |   25.2 |   27.6 |          33.0 |

What is left is rendering the ~1 MB of SVG (25 ms), which rule 3 keeps
per request.

`/:owner/:name/commits` names `session`, `repo`, `log`, `refs` and `render`
the same way (#3392).

`/map`'s `Server-Timing` names where that goes (#3159): `app` is the total,
then `session`, `lanes` (the cache lookups, and the build on a miss, less the
layout inside it), `layout` (graph layout on a miss) and `render`. Their sum
is never more than `app`; the rest is routing and sending. One
`bun run bench/map-home.ts` run (`--n 30`, warm, so `layout` is a cache hit
and rounds to 0.0):

| `GET /map` phase | owner p50 | owner p95 | stranger p50 | stranger p95 |
| ---------------- | --------: | --------: | -----------: | -----------: |
| total (`app`)    |      27.8 |      31.2 |         27.2 |         29.6 |
| `session`        |       0.2 |       0.3 |          0.2 |          0.3 |
| `lanes`          |       1.8 |       2.2 |          1.7 |          1.9 |
| `layout`         |       0.0 |       0.0 |          0.0 |          0.0 |
| `render`         |      17.7 |      20.1 |         17.4 |         19.1 |

### Where the time goes

- **`/map`: `layout` of the big lane alone takes 408 ms of the ~490 ms
  `globalLanes` spends on all ten lanes** (timed one stage at a time on the
  same fixture). The big lane's other stages are `readyNow` at 27 ms,
  `marksFor` at 27 ms and `repoGraph` at 12 ms.
  Rendering every lane's SVG takes 19 ms. `layout` is a pure function of
  the graph's issue ids, numbers and edges (crossing reduction in `order`),
  so it is the first thing to cache. Its key is its own input.
- **`/map`: 2,348 of the 2,685 statements are one query**,
  `SELECT raised_at FROM issue_raise WHERE issue_id = ?1`, run once per
  issue by `raisedAt` (`core/thought_links.ts`) inside `repoGraph`. That is
  a per-row read, and it gets a grouped `IN (…)` read. Next come the crew
  role lookups (42 per request) and `SELECT * FROM user` (34–40).
- **`/`: about 70% of the time is the feed region** (`/live/feed` alone
  takes 77 ms of `/`'s 111 ms). It runs 840 issue reads
  (`SELECT issue.*, … WHERE …`, one per candidate) and 600
  `SELECT sealed, author_id FROM issue WHERE repo_id = ?1 AND number = ?2`
  (`mayViewId`, one per item) on each request. Both get grouped reads. The
  shelf (`/live/apps`, 2 ms) and the "On you" card (`/live/on-you`, 13 ms)
  are not worth a cache.

## The map (`/map`, `/:owner/:name/map`, `/api/v1/map`)

### 1. The layout: content-addressed

- **What:** a graph's `Layout` with every `Placed.issue` replaced by its id
  (level, slot, island, routes, levels, width, islandFrom). Titles, states
  and assignees are never in the entry. They are put back from the
  request's own graph, so an edited title shows on the next view.
- **Key:** `layout:` + sha256 of the graph's issues in order (`id:number`)
  and its edges (`blockedById>issueId`). A viewer can only produce the key
  of a graph they were allowed to read, and the entry only says where those
  same ids sit. Two viewers with the same visible graph share the entry.
  A viewer who sees one more sealed issue gets a different key, so sharing
  can never place a card someone may not see.
- **Invalidated by:** nothing. A different graph is a different key. Any
  write that changes the graph (the lane table below) misses the old
  entry, and the LRU evicts it.
- **Max age:** none needed for correctness. Unused entries are evicted
  after 1 hour, with a cap of 256 entries.

### 2. The lane: one repository's map for one scope

- **What:** everything `globalLanes` builds for one repository: its `Graph`,
  `Marks`, ready list, critical path, word counts, the runs in flight that
  the scope may see, the workers' usernames, `idle`, and the autonomy
  status. The per-repository map page and the API read the same entry.
- **Key:** `lane:{repoId}:{head}:{scope}:{utcDay}`.
  - `head` is the repository's `MAX(event.seq)`. One grouped read covers
    every lane on the page: `SELECT repo.id, (SELECT MAX(seq) FROM event
    WHERE repo_id = repo.id) FROM repo WHERE repo.id IN (…)`. (A grouped
    `MAX … GROUP BY` scans every event of every listed repository, 17 ms
    on the fixture; the correlated form is one index seek each, 0.3 ms.)
  - `scope` comes from `sealedScope(db, repo, viewer)`, worked out fresh:
    `all` for a writer or the crew, `own:{userId}` for any other signed-in
    active account, `none` for no one. Every part of a lane that reads
    issues must respect it, including the reads outside `repoGraph` (the
    runs filtered by `mayViewId`, `parkedTwice`, `proposedWork`). #2716's
    test warms a lane as the owner and reads it as a stranger to show that
    it does.
  - `utcDay` is part of the key because the spend bar and its ceiling reset
    at UTC midnight.
- **Not cached:** which lanes the page has (`listReposVisibleTo` for the
  viewer, worked out on every request), the order of the lanes, and the
  HTML.
- **Invalidated by:** every write in the table below, because each one
  appends an event on the repository and so moves `head`. The bus listener
  may also delete `lane:{repoId}:*` as soon as it sees such an event. That
  frees memory sooner, but correctness never depends on it.
- **Max age:** 60 seconds. That covers the inputs that move without an
  event on the repository (see "Gaps") and spend reported by another
  process.

## Home (`/`)

### 3. The feed's first page: per viewer

- **What:** the candidate rows (`src/feed/items.ts`) after the viewer's
  access filter and before ranking. Ranking decays with time
  (`feed/affinity.ts`), so it is redone on every request, and so is
  rendering.
- **Key:** `feed:{viewerId}:{head}`. Here `head` is the forge-wide
  `MAX(event.seq)`, because any event may be a feed item.
- **Invalidated by:** every append to the outbox, so every write. The
  table below does not list them one by one: the rule is "any event".
  When the forge is busy, the hit rate is the rate at which a person
  reloads faster than events arrive. That is why the grouped reads under
  "Where the time goes" come first and this cache comes second.
- **Max age:** 30 seconds. Asks and decision outcomes are read from what is
  true now, not from events.

### 4. The KPI row (after #2665): forge-wide, admin only

- **What:** the numbers #2665 puts at the top of the owner's home:
  landings per hour (24 h sparkline), the live version and when it went
  live, the median check time, crew builders active out of slots, today's
  spend against the ceiling, and the age of the last good off-box backup.
  Numbers only, rendered for each request. The visitors tile also carries
  30 days of distinct visitors per day (#3186), part of the same entry and
  so admin-only by the same gate.
- **Key:** `kpi:{head}:{utcHour}`, a single entry. It is read only **after**
  the request has established `viewer.isAdmin`. The figures add up private
  repositories, so the entry is admin-scoped by its gate, and a viewer who
  is not an admin never reaches the read. #2717's test says the owner's
  KPIs never render for another viewer.
- **Invalidated by:** the KPI writes in the table below, by moving the
  forge-wide `head`.
- **Max age:** 30 seconds. The backup's age and "per hour" move with the
  clock, not with events.

### 5. Pinned board panels (after #2665): admin only, per panel

- **What:** each pinned panel's query result (`boards/query.ts`), the
  same rows `/boards` shows for it.
- **Key:** `panel:{boardSlug}:{boardOid}:{panelIndex}:{head}`. Boards are
  an admin's (`actions/boards.ts` refuses everyone else), and a panel runs
  with every repository in scope. So, like the KPI row, the entry is read
  only after the `isAdmin` check. `boardOid` is the board file's blob id
  in the boards repository, so an edited board is a new key.
- **Invalidated by:** any event, through `head`, plus the board writes in
  the table below (a push to the boards repository is one of them).
- **Max age:** 30 seconds.

### Where a code page's time goes (#3194)

A repository's tree and blob pages (`/:owner/:name/tree/…`, `/blob/…`) name
each phase once, after `app`; the phases never add up to more than `app`.

- `session`: resolving the viewer, as on `/map`.
- `git`: every object read of the request summed into one entry: the tree
  or blob, the ref set and the explorer's listing.
- `highlight`: blob only; `highlightBlob`, the syntax colouring. A rendered
  Markdown file and a binary or oversized file send none.
- `render`: building the page, less highlighting. On a tree it includes the
  README read, which happens while the page is built. On a blob it is the
  pane plus the page; the `?fragment=1` preview sends the pane alone, and
  the explorer fragment of a tree sends no `render`.

### Where home's time goes (#3160)

`/`'s `Server-Timing` names `feed`, `kpis` and `panels` for a signed-in
viewer, and `shelf` on the anonymous door. A phase is written only for a
region the viewer is shown: a non-admin gets `feed` and no `kpis` or
`panels`. A phase whose cache answered carries `desc="hit"`
(`kpis;dur=0.2;desc="hit"`); the hit is read off the cache's counters, so
under concurrent requests it can be credited to the neighbour. `feed` is
the whole region, ranking and rendering, with the candidate cache inside it.
One `bun run bench/home-phases.ts` run (owner, `--n 30` warm, the snappy
fixture; all three caches hit):

| `GET /` phase | owner p50 | owner p95 |
| ------------- | --------: | --------: |
| total (`app`) |      15.3 |      19.7 |
| `kpis`        |       0.2 |       0.3 |
| `panels`      |       0.1 |       0.1 |
| `feed`        |       7.1 |      10.0 |

### Not cached on home

The anonymous door (1.5 ms, 10 statements), the app shelf, and the
"On you" card. Each costs less than its cache's key would.

## The writes that invalidate

Each row is an action (or, for a push, the post-receive hook, the one
`bus.append` outside `src/actions/`), and the event it appends. The event
is what moves the cached entry's `head`. `test/caching-doc.test.ts` reads
these tables and checks that each named function exists in its file and
that the file appends the event named beside it. If an action is renamed,
or stops saying what it did, this doc goes red before the cache goes stale.

### Lane writes (cache 2; every event here has the repository's id)

| write                             | event                          | changes                                  |
| --------------------------------- | ------------------------------ | ---------------------------------------- |
| `actions/issues#openIssue`        | `issue.opened`                 | a card appears                           |
| `actions/issues#openIssueThrough` | `issue.opened`                 | a card appears (a mirror)                |
| `actions/issues#editIssue`        | `issue.edited`                 | a card's title                           |
| `actions/issues#setIssueState`    | `issue.closed`                 | a card goes, a blocker frees             |
| `actions/issues#setIssueState`    | `issue.reopened`               | a card comes back                        |
| `actions/issues#setIssueStateThrough` | `issue.closed`             | the same, on a mirror                    |
| `actions/issues#setIssueSealed`   | `issue.sealed`                 | who may see a card                       |
| `actions/issues#setIssueSealed`   | `issue.unsealed`               | who may see a card                       |
| `actions/sealed#unsealReleased`   | `issue.unsealed`               | who may see a card                       |
| `actions/issues#assignIssue`      | `issue.assigned`               | who is on a card                         |
| `actions/issues#setIssueLabels`   | `issue.labeled`                | pillars, the Later gate                  |
| `actions/issues#addComment`       | `issue.commented`              | parks (`struckOut`, `parkedTwice`)       |
| `actions/dependencies#linkIssue`  | `issue.blocked`                | an edge                                  |
| `actions/dependencies#unlinkIssue` | `issue.unblocked`             | an edge                                  |
| `actions/dependencies#confirmIssue` | `issue.confirmed`            | a held edge                              |
| `actions/plan#openPlan`           | `issue.opened`                 | cards and edges at once                  |
| `actions/pillars#followLink`      | `issue.blocked`                | an umbrella's edge                       |
| `actions/pillars#inheritPillar`   | `issue.labeled`                | a card's pillar                          |
| `actions/pulls#openPull`          | `pull.opened`                  | "waiting" (`proposedWork`)               |
| `actions/pulls#mergePull`         | `pull.merged`                  | a card closes                            |
| `actions/holds#holdPull`          | `pull.held`                    | "on hold" (`holdsFor`)                   |
| `actions/holds#releasePull`       | `pull.released`                | "on hold"                                |
| `actions/runs#announceRun`        | `run.queued`                   | a ringed card, the lane's crew           |
| `actions/runs#announceRun`        | `run.started`                  | a ringed card, the lane's crew           |
| `actions/runs#announceRun`        | `run.finished`                 | a ringed card, the lane's crew           |
| `actions/crew#addToCrew`          | `crew.added`                   | who speaks for the crew                  |
| `actions/crew#removeFromCrew`     | `crew.removed`                 | who speaks for the crew                  |
| `actions/repos#updateRepoSettings` | `repo.settings_updated`       | autonomy, ceiling, slots                 |
| `actions/repos#setCrewOutsiders`  | `repo.crew_outsiders`          | unadopted cards                          |
| `actions/returns#reportSpend`     | `spend.reported`               | the spend bar                            |

### KPI writes (cache 4)

| write                                | event                  | changes                     |
| ------------------------------------ | ---------------------- | --------------------------- |
| `http/server#handleHook`             | `push`                 | landings per hour           |
| `actions/pulls#mergePull`            | `pull.merged`          | landings per hour           |
| `actions/runs#announceRun`           | `run.finished`         | median check time, builders |
| `actions/runs#announceRun`           | `run.started`          | builders active             |
| `actions/capacity#changeCapacity`    | `capacity.changed`     | builders' slots             |
| `actions/returns#reportSpend`        | `spend.reported`       | today's spend               |
| `actions/model_grant#setAccountCeilings` | `account.ceiling_set` | the ceiling                |

### Panel writes (cache 5)

| write                        | event           | changes                |
| ---------------------------- | --------------- | ---------------------- |
| `actions/boards#writeBoard`  | `board.saved`   | a panel's query        |
| `actions/boards#changeBoard` | `board.saved`   | a panel's query        |
| `actions/boards#deleteBoard` | `board.deleted` | a pinned panel goes    |
| `http/server#handleHook`     | `push`          | a board edited in git  |

## Gaps: writes that change a lane without an event on its repository

Closed by #2716, except the clock:

- **A thought raising an issue** (`raiseIssue` from `crew/triage.ts`):
  `crew/triage` now appends `issue.raised` with the repository's id beside
  it, so `head` moves.
- **A fleet "move limb"** (`moveLimb` from `fleet/verbs.ts`): the verb
  already appends `limb.moved` with the repository's id.
- **A username change** (`user.updated`, no repository): the lane keeps its
  workers' ids, never their names. The names are read on every request in
  one grouped read.
- **The clock:** "deferred" and the spend day turn over with time. The
  `utcDay` in the key covers the spend; the 60 s max age covers the rest.

## Budgets

These are what #2716 and #2717 test against, on the forge-sized fixture,
warm:

- **`/map`: p95 ≤ 50 ms on the bench, and a statement count that does not
  grow with the plan.** Measured warm (#2716): 25 statements for the owner
  (10 lanes) and 33 for a stranger (8 lanes), against 2,685 and 2,637.
  About 25 of them are the page around the lanes (session, settings, the
  repository lists the chrome reads); each lane adds at most two (its head
  is one grouped read for all of them, and `canWrite`'s owner lookup is
  one per lane for a viewer who is not an admin). The first draft of this
  budget, 2 + 2 × lanes, left the page's own chrome out. The test
  (`test/map-cache.test.ts`) asserts 26 + 2 × lanes, which does not depend
  on the machine. Its wall-clock bound is 200 ms p95, the floor
  `test/flake.test.ts` allows a request; the 50 ms is read off the bench.
- **`/`: p95 ≤ 50 ms on the bench, and a statement count that does not
  grow with the feed's candidates** (the `test/counts.test.ts` pattern).
  The test's wall-clock bound is 200 ms, for the same reason.

## Max ages, at a glance

| entry              | key carries                     | max age |
| ------------------ | ------------------------------- | ------: |
| map layout         | the graph's own ids and edges   | 1 h idle (LRU) |
| map lane           | repository head, sealed scope, UTC day | 60 s |
| home feed page     | viewer, forge head              |    30 s |
| home KPI row       | forge head, UTC hour; admin-gated |  30 s |
| home pinned panel  | board blob, panel, forge head; admin-gated | 30 s |

## Raw files at a full commit id (#3381)

`GET /:owner/:name/raw/:ref/*path` is the one place the forge tells shared
caches (browsers, a CDN, a proxy) to keep bytes for a year.

| `ref` is                  | repository | `Cache-Control`                          |
| ------------------------- | ---------- | ---------------------------------------- |
| 40 hex digits (a commit)  | public     | `public, max-age=31536000, immutable`    |
| 40 hex digits (a commit)  | not public | `private, max-age=31536000, immutable`   |
| a branch, tag or anything else | any   | `private, max-age=0` (revalidates)       |

- **Why immutable.** A full commit id names one tree forever, so the bytes
  at a path under it can never change. A branch name moves, so it always
  revalidates.
- **Public vs private.** Only `repo.visibility === "public"` (wired in
  `rawBlob`) allows `public`. Any other repository is `private`: the
  browser may keep it, a shared cache may not.
- **ETag and 304.** Every raw answer carries the blob's own oid as a strong
  `ETag`. `If-None-Match` naming it (weak or strong, a list, or `*`) gets a
  bodiless 304 that keeps the same `Cache-Control`, `nosniff` and sandbox
  CSP. A branch read changes oid only when the file changes, so it costs
  one round trip and no body.
- **Why the blob page is left out.** `/:owner/:name/blob/...` is HTML: it
  carries the viewer's name, a CSP nonce and links that change with the
  repository, so it is not a function of the commit alone. Only the raw
  bytes are. The origin-browse raw route (`browseRaw`) is also left alone:
  its source is another host, whose bytes this forge cannot vouch for.
- **Known limit.** A public repository that later turns private keeps
  year-long `public` copies in whatever shared caches already fetched
  them; the forge cannot recall them. Anyone who needs that undone must
  purge those caches. A commit id is also not secret once public.

## What is built (#2675)

The map half is #2716's (`web/map_cache.ts`, numbers above). #2675 adds
the grouped reads under both pages and the home half.

**Grouped reads** (rule 6), which serve a cold miss as well as a warm hit:

- `raisedAt` (`core/thought_links.ts`) runs one `IN (…)` per 400 issues.
  It was the 2,348-statement query on `/map`.
- The feed reads every event's subject once per window
  (`getIssuesByNumbers` + `joinMany` in `feed/items.ts`). It was 840 issue
  reads.
- `audienceFilter` reads every sealed row once per window when its caller
  has the window (`eventRows` in `core/sealed.ts`). It was 600 reads.

**Cache 3, the feed**, is `viewerCandidates` in `feed/feed.ts`, built with
one difference from the design. The key is viewer and chips, the max age is
30 s, and the bound is 200 entries (`kernel/stamped.ts`). The stamp is not
the forge-wide `MAX(event.seq)` but `writeStamp` (`core/write_clock.ts`):
SQLite's `total_changes()` and `PRAGMA data_version`, read in one statement.

- **Why it differs.** The feed's asks and decision outcomes are read from
  what is true now, not from events (the design says so under cache 3). A
  clock that moves on every row written catches those writes at once,
  rather than at the max age. `data_version` moves when another process
  commits, as rule 4 asks.
- **What it costs.** Any write invalidates every viewer's entry. Since any
  event already does under the design, the hit rate barely changes.
- **Transactions.** Inside an open transaction there is no stamp, and
  nothing is cached: a rolled-back write leaves `total_changes` moved.
- **Triggers were tried and removed.** Per-repository trigger counters
  break bun's `changes`, which counts a trigger's rows, and every
  `changes === 1` compare-and-swap in the codebase with it.

Measured on `bench/snappy.ts`'s smaller fixture (12 apps of 24 issues), 100
requests, before the map half landed:

| request             | before p50 / p95 | before SQL | after p50 / p95 | after SQL |
| ------------------- | ---------------- | ---------: | --------------- | --------: |
| `/` owner           | 73.1 / 97.7 ms   |       1892 | 19.5 / 29.9 ms  |       135 |
| `/` member          | 31.8 / 35.9 ms   |        743 | 9.4 / 11.7 ms   |       113 |
| `/` owner, cold     | 73.1 / 97.7 ms   |       1892 | 26.5 / 34.7 ms  |       192 |

The asks' per-pull reads that remained after this (#2772) are grouped by
#2780, and home now reads its asks once. The feed cache's key says whether
asks are in, because home asks for the feed without them.

`test/snappy.test.ts` holds both pages' budgets on that fixture, warm and
cold (a write before each request). It also checks:

- a write through an action is on the next map and the next feed;
- a sealed card and one viewer's feed never reach another viewer,
  whichever order warmed the cache;
- there is no stamp inside a transaction, and another connection's write
  moves it.

**Caches 4 and 5, the KPI row and pinned panels** (#2717) are
`web/studio/home_cache.ts`, read only after `viewer.isAdmin` (home calls
them for no one else, and `test/home-cache.test.ts` warms them as the owner
and reads home as a member and as a stranger). Like the feed they are
stamped with `writeStamp`, not the forge-wide `MAX(event.seq)`: the KPI
figures read `run`, `pull`, `usage` and `page_vital` rows, some of which
append no event, and a clock that moves on every row catches all of them.
The KPI entry is keyed by UTC hour, ceiling and data directory; a panel by
its board's slug and its own definition (an edited board is a new key, as
the blob id would make it). Max age 30 s for both. Measured on
`bench/snappy.ts` (`--n 50`), `/` owner: 105.7 → 90.1 statements, p50
16.0 → 15.5 ms, p95 22.5 → 20.7 ms; the fixture pins no panel, and a pin
adds one query per panel on a miss and none on a hit.
