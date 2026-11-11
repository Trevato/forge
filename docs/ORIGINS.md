# Origins

This document describes how a forge connects to other forges. It is for people
who work across forges and for developers who change the connections.

An **origin** is a connected account on another forge: GitHub, Forgejo, Gitea or
another forge of this kind. You **mirror** repositories from an origin, and their
issues, pulls, comments and labels are imported with the git objects. Anything
you do to a mirror is written to the origin first and reflected locally after.
See also [A forge is an origin](features/forge-origin.md).

## The provider interface

Git is the common layer for code. No standard exists above git, so each forge has
an adapter behind one `Provider` interface (`src/origins/types.ts`). Adapters are
small because forges share the same units: issues, pulls, comments and labels.

## Truth

- Native repo: **git is truth** for code, and the database indexes it. Issues,
  pulls and comments are stored in the database.
- Mirrored repo: **the origin is truth** — for git objects, issue numbers,
  states, labels and comments. Local rows are a cache with provenance
  (`origin_remote_id`, `origin_author`, `origin_html_url`, `synced_at`).
  Every write goes to the origin first; if the origin refuses, nothing
  changes here and the user sees the origin's reason.

Consequences: a mirrored repo's issue numbers equal the origin's; `#42` is
the same conversation on both sides. Local-only state on a mirror is a bug,
so the actions refuse it mechanically — `openIssue`, `addComment`,
`setIssueState` and `setIssueLabels` return `"mirrored"` on a mirror, and
their `…Through` twins are the path that works for both kinds of repo.

## Model (migrations 8 and 9)

```
origin        a connected account: kind, api_url, web_url, login, token_enc,
              auth_kind (pat|oauth), refresh_token_enc, expires_at, needs_reauth
origin_app    an OAuth application registered on one instance (per user)
oauth_flow    a connect in flight: a device poll, or a state+PKCE round trip,
              plus a short_code and the sealed target it redirects to
origin_repo   the origin's repo list, cached for the import picker
              + fork_of: `owner/name` this remote repo forks (getRepo only)
origin_cursor per-origin sync watermarks and the next-due / paused-until times
repo          + origin_id, origin_full_name, origin_remote_id, origin_html_url,
                last_fetch_at, fetch_error      (origin_id set ⇒ mirrored)
              + origin_fork_of: the upstream `owner/name` this mirror forks
              + origin_detached_at: when its origin went (mig. 72; trigger)
              + require_review (0/1): the merge gate                (mig. 13)
issue/comment + origin_remote_id, origin_author, origin_html_url, synced_at
label         + origin_remote_id
pull          + origin_head_repo
review        a verdict on a pull: state, body, commit_oid, and for an
              imported one origin_remote_id + origin_author        (mig. 13)
review_thread (issue, anchor) → resolved_at, resolved_by           (mig. 13)
pin           (user, repo) — what the local client keeps cloned
```

Tokens are encrypted at rest (AES-256-GCM) with a key file the forge creates
in the data directory (`<data>/secret.key`, mode 0600 — the forge refuses to
boot if it is wider than that). The ciphertext is bound to its own row id as
additional authenticated data, so moving a row's token onto another origin
stops it decrypting. Tokens are never logged (`kernel/log.ts` scrubs
credential-shaped strings out of every line), never returned by any API,
never placed in a git URL or argv — git receives them through
`GIT_CONFIG_COUNT/KEY/VALUE` as an `http.<clone-url-origin>/.extraHeader`,
scoped to the one host and with redirects disabled.

Imported issues keep `author_id` = the connecting user so every join and
permission check keeps working, and carry `origin_author` (the login on the
origin) which both surfaces display in its place, with the origin's mark. The
connecting user owns the mirror, so "author-or-writer" checks resolving to
them is correct.

## Connecting and mirroring, as a person does it

Outbound git refuses a host that resolves to a private address. A site admin can vouch for exact host names (the owner's own Forgejo, reached by its in-cluster address): `FORGE_OUTBOUND_TRUSTED_HOSTS=git.example.test` (comma or space separated), plus the same list editable by an admin on **Settings → Origins**. A trusted host may resolve privately for origin sync, mirror, migrate and write-through; trust is by name, never by address range, and webhooks never read it. A host name in `FORGE_ORIGIN_ALLOW` is trusted the same way for its origin's mirror, sync and fetch, so an origin that connects can be mirrored; an address named there is not (trust is by name). The origin row says "trusted internal host". In the terminal, the palette's **Trusted hosts** reads and saves the same list (admins only, same audit). An entry that is not a bare host name (an address, a wildcard, a URL) is refused with its name, on the page and in the terminal, never silently dropped.

A pull from an outsider's fork on the origin is someone else's code, so its
check and preview wait. A person with write access lets that exact head run:
on the pull page, **Approve to run here**; in the terminal, `A` on the pull
("approve to run here"); over the API, `POST
/api/v1/repos/:o/:n/pulls/:n/approve-here`. It is a local record — a review
written through to, or imported from, the origin never counts — and a new push
waits for a new approval.

A pull a child forge proposed upstream waits the same way, and the writer who
minted the child's token may let it run: **Let it run here** on the pull page,
`A` in the terminal, or the same `POST …/approve-here`, which answers
`{granted: true, commitOid}`. That grant is recorded apart from reviews: it
never counts toward `require_review` or the merge gate, a new push needs a new
grant, and a proposed pull never lands on its own, even on an autonomous repo.

Connect one at **Settings → Origins** (or `A` then `o` in the terminal). The
terminal lists the ones you have connected under the palette's **Connected
origins** (a signed-in person's, never an agent's or a guest's): `j`/`k` move,
`s` syncs the selected origin now and says how many repositories it found (or
the report's error), `d` asks first and then disconnects it, as Settings →
Origins does (`syncOriginNow`, `disconnectOrigin`; another person's origin id
is "No such origin."). Which
way in you get is a property of the forge, not a preference:

- **GitHub** — a device code. The forge shows a short code and a URL; you type
  the code on whatever device has a browser, and the forge does the polling (once per
  flow however many tabs wait; the page is told over a stream and reloads once). Setting
  it up is three steps, once, for everyone on the forge:
  1. Create an OAuth App at <https://github.com/settings/developers>. Name it
     anything, set the homepage to your forge's URL, set the authorization
     callback URL to `https://your.forge/settings/origins/callback`, and tick
     **Enable Device Flow**.
  2. Start the forge with `FORGE_GITHUB_CLIENT_ID=<client id>`.
     `FORGE_GITHUB_CLIENT_SECRET` is optional and buys one thing:
     disconnecting revokes the grant on GitHub too.
  3. The GitHub button appears. Until it does, both surfaces print these three
     steps rather than naming an environment variable and leaving you to it.

- **Forgejo / Gitea** — authorization code with PKCE. They implement no device
  grant, and every instance needs its own OAuth application, so you paste a
  client id once per host — or the operator registers the host once for
  everyone, `FORGE_ORIGIN_CLIENT_ID=git.example=<client id>` (comma-separated
  for more), and Connect is one click. The page gives you the exact redirect
  URI to enter (`https://your.forge/settings/origins/callback`); a public
  client is fine.
  This flow needs the forge to know its own public URL, since that URL is
  registered with the other forge and a `Host` header is not evidence: set
  **`FORGE_URL`** to the canonical base URL (`FORGE_HOST` and loopback are the
  fallbacks it trusts). Until one of those is true the card says so, and the
  token path still works.
- **A pasted token** — the fallback that needs no registration anywhere. It is
  validated against the origin before it is stored, encrypted at rest, and
  never displayed again.

Both connect screens hand the job to whatever device has a browser: a **QR
code** to point a camera at, a **short link** (`https://your.forge/go/<10
characters>`, live for ten minutes and gone once used) short enough to type by
hand, and — in the terminal — `c` to put the link on _your_ clipboard through
your own terminal (OSC 52, so it works over SSH; iTerm2, Ghostty, kitty and
WezTerm honour it, Apple Terminal does not). `o` opens a browser only when the
forge's terminal is the one in front of you; over SSH it says so rather than
appearing to work.

Then pick what you want: **Repositories** on an origin lists everything the
token can see, and you mirror them one at a time. There is no "mirror
everything" — a mirror is a repository you own, and a hundred you did not
choose is not a feature.

A mirrored repo wears its origin in the header (`mirrored from owner/name @
host`), shows its last fetch and any fetch error in the About rail, and syncs
on a worker tick or on demand. Imported issues and comments show the login on
the _origin_, with that forge's mark, and link back to the canonical thread.
Merging a pull happens on the origin: the merge box says so and links there,
and the next sync brings back the merge commit it actually made. Pushes go
through too — the pre-receive hook forwards the push upstream first, so a push
the origin refuses never lands here either.

Mirror fetches are vetted and pinned: the origin's host is resolved once, refused
if it is a loopback, LAN or other private address, and git is pinned to the
address that passed. Git follows no redirects for a mirror, so give the clone
URL in its final form (https, with the `.git` suffix the host expects); a URL
that redirects fails with git's redirect error.

Only the person who connected an origin can write through it. Another writer
gets `origin_owner_only` rather than a comment appearing upstream under
someone else's name with someone else's token.

**Pins** are the bridge to the next section: the pin toggle on a repository
header (`p` on a row in the terminal, `P` on a repo's home) says "keep this on
my machine", and the dashboard grows an **On your machine** card listing them.
The server remembers only the choice — nothing about the state of a laptop —
and `forge sync` (docs/ON-YOUR-MACHINE.md) is what acts on it.

## Flows

**Connect.** Three ways in, and which one you get is a property of the forge
rather than a preference:

- **GitHub — the device grant** (RFC 8628). The forge shows a short code and
  a URL; you type the code into whatever device has a browser; the forge
  polls. This is the flow that works over SSH with no browser on the server.
  It needs only a public client id (`FORGE_GITHUB_CLIENT_ID`); a client
  secret is optional and only buys revoke-on-disconnect.
- **Forgejo / Gitea — authorization code with PKCE (S256).** They implement
  no device grant at all — their token endpoints accept only
  `authorization_code` and `refresh_token` — so the browser goes to the
  instance and comes back to `/settings/origins/callback`. Every instance
  needs its own application registration, so the user pastes a client id
  once per host (`POST /api/v1/user/origin-apps`); a public client is fine,
  and PKCE is mandatory for one.
- **A pasted token**, still, as the fallback that needs no registration
  anywhere.

Both OAuth flows end with a URL somebody has to open on a device that has a
browser, which over SSH is a string that can be neither clicked nor reliably
copied. So a flow also carries a **short link**: ten Crockford-base32
characters of crypto randomness on the row, redirected by `GET /go/<code>`
(migration 10). That route is deliberately anonymous — the phone typing it has
never signed in here and the target is a public page — and it answers only
while the flow is pending and unexpired; an unknown code and a dead one give
the same 404, byte for byte. The target is sealed at rest like every other
secret in that table, because a code flow's authorize URL carries the `state`,
and it is never written to a log. Both surfaces render the link as a QR code
(`src/design/qr.ts`, zero dependencies) beside the link itself; the terminal
also offers OSC 52 copy, which reaches the user's own terminal rather than the
server's clipboard.

The flow's own page (`/settings/origins/flows/:id`) links to that sealed
URL and to nothing else — never to one from its query string — after
checking it again: the instance's `/login/oauth/authorize`, the flow's
client id and callback, a PKCE challenge. A `to` an older link still
carries must equal it exactly. A flow past its ten minutes says "This
connect link expired", with a fresh **Connect**.
(`test/origin-flow-page.test.ts`; `test/oauth-connect-browser.test.ts`
clicks Authorize and Continue in headless Chromium.)

Discovery: `github.com` is known by name. Otherwise `GET /api/v1/version` —
NodeInfo is the one thing here resembling a standard and no live Forgejo
serves it, so it is only an opportunistic first probe. The version string is
the discriminator: `16.0.1+gitea-1.22.0` is Forgejo declaring the Gitea API
generation it implements; a bare version is Gitea. GitHub Enterprise
publishes neither, so the user names it (`kind: "github"` with a host →
`/api/v3`). `whoami()` then validates the credential and fixes `login`.

Discovery fetches a host a stranger named, so it is https-only, refuses
resolves the name and refuses any private answer (`vetHost`, at every hop,
dialling the address it judged), refuses non-http schemes, follows no redirect
off-host, reaches loopback only in dev (`FORGE_DEV=1`), caps the body at 64 KB and times out in 5 s. An operator can vouch for a LAN
or plaintext host with `FORGE_ORIGIN_ALLOW=host[,host…]`; there is no
per-user toggle, because the risk it accepts belongs to the server. A host
name vouched for there is trusted for that origin's git as well (mirror,
sync, fetch, push), as `FORGE_OUTBOUND_TRUSTED_HOSTS` is: by name, pinned to
the answer that passed. So an origin that connects can be mirrored. An
address literal named there reaches discovery only: trust is by name.

**Refresh.** A Forgejo OAuth access token lives about an hour, so it is
refreshed a minute before it expires rather than after a 401. Refreshes are
serialised per origin — two in parallel against a rotating provider spend the
token twice, and the loser presents one the winner already invalidated — and
the new pair is written before the new access token is used. `invalid_grant`
and `unauthorized_client` (Forgejo's answer to a replayed refresh token) are
both terminal: the origin is marked `needs_reauth`, an `origin.needs_reauth`
event is appended, and sync skips it until a human reconnects.

**Pick, then look, then decide.** `listRepos` fills `origin_repo`; the picker
shows every remote repo, and each row says whether we already mirror it
(`mirroredAs`). Opening one does **not** mirror it: it **browses** it live,
read-only, through the origin's own API — README, tree, files, branches,
tags, commits with diffs, issues, pulls, comments, labels — with a banner
saying where you are. Mirroring is then a deliberate second act with visible
progress. Enter used to mean "clone this and import all of it", which took
seconds with nothing on screen and made looking at a repository cost the
same as adopting one.

**Browse.** One interface, `RepoSource` (`src/view/source.ts`), answers every
repo screen's questions; two implementations answer them. `localSource` reads
`git/read.ts` and the core tables exactly as the pages do today.
`originSource` reads a `Provider` and shapes the answers into the same values
— a remote tree entry becomes the `TreeEntry` `ls-tree` yields, a remote blob
becomes the three states `blobForRender` yields, a remote commit becomes
git's `Commit` with the origin login beside the name. So a screen renders a
`RepoSource` and never asks which one it holds. `sourceFor(app, actor, ref)`
picks the implementation and enforces access in one place: `canRead` for a
local repo, and **the origin's owner and nobody else** for a live browse,
because the browse spends their credential on another forge. Both refusals
are `not_found` (invariant 9).

Nothing on `RepoSource` writes, in either implementation — `capabilities`
tells a surface which buttons to draw, and the absence of methods is what
makes read-only mechanical rather than promised. What the origin does not
offer, the source does not invent: a live browse reports no issue counts
(neither forge gives both cheaply) and no mergeability, as `null` rather than
a guess, and a label or author filter narrows the page in hand rather than
pretending the origin searched.

Live reads are cached per process (`src/view/cache.ts`), keyed by origin,
repo, method and arguments: 60 seconds for a moving target (branches, lists,
a ref's log), 10 minutes for anything addressed by an object id, which cannot
change. Bounded by entry count and by the bytes of the blobs among them —
an LRU without a byte budget is a memory leak with good manners. Conditional
requests live a layer below, in `ApiClient`'s ETag cache, so a miss here is
often still a 304 there. The mirror job and the sync worker `bust` a repo's
keys the moment the truth upstream moves.

Blobs are capped at 1 MB and diffs at 2 MB before the request is made, not
after: browsing a stranger's repository must cost a bounded amount of memory
whatever it holds. Over the cap a blob is `too_large` with no body, which is
also what the API returns (413), exactly like the local contents route.

**Mirror.** Mirroring creates a local repo under the user's namespace (name
collisions get a `-<host>` suffix), configures a bare repo with explicit
refspecs, fetches, installs hooks, imports labels, then issues and pulls
(with comments and reviews). Visibility follows the origin's — a private or
Forgejo-`internal` repo becomes private here.

It runs as a **job** (`src/origins/jobs.ts`): `startMirror` returns
immediately with `{ id, originId, fullName, stage, detail, startedAt,
finishedAt?, repo?, error? }`, and the work reports its way through
`creating → fetching → labels → issues → pulls → comments → done`, with a
detail line ("42 issues") from the import itself — there is one place that
knows how far an import has got, and it is the import. `subscribe(jobId, cb)`
feeds a live UI (and the SSE route); `settled(jobId)` is what a caller that
just wants the repository waits on. A second start for the same remote joins
the running job rather than beginning a second clone. Failures land on the
job (scrubbed) and in `fetch_error`, never thrown — the work is detached from
any request, so a rejected promise would take the process with it. The
registry is in memory on purpose: progress is not state worth persisting, and
a job row that outlived its process would be a lie about it. What is durable
is what always was — the repo row, `repo.mirrored`, `push`, and `repo.imported`.

**Sync.** A worker tick (beside the delivery worker) picks origins due for a
sync (default every 10 minutes, or on demand). Per mirrored repo:
`git fetch --prune` with the origin's auth env; refs that moved emit a `push`
event with `via: "origin"` so webhooks, SSE and the activity feed see
upstream activity; then incremental `listIssues(since = watermark − 5 min)`
for issues and pulls, upserting by `origin_remote_id`, and comments/reviews
for each _changed_ item. The watermark is when the run started (not the
newest `updated_at` seen) and it advances only on a clean run, so a failure
mid-sweep is a re-fetch rather than a hole. Conditional requests and both
rate-limit header dialects (`X-RateLimit-*` and RFC 9331 `ratelimit`) are
honoured; a rate-limited origin is skipped until `retryAt`. Failures land in
`last_error` / `fetch_error`, visible in both surfaces, never thrown into the
loop.

**Write-through.** On a mirrored repo `openIssueThrough`, `addCommentThrough`,
`setIssueStateThrough`, `setIssueLabelsThrough` and `openPull` call the
provider first, then upsert the returned item locally (so the number and
timestamps are the origin's), then append the usual event marked
`via: "origin"`. **Only the person who connected the origin may write through
it** — any other local writer gets `origin_owner_only`, because their comment
would otherwise appear upstream under someone else's identity with someone
else's token. Sharing a mirror's write access across a team wants an explicit
per-repo opt-in and a delegation model; that is deliberately not v1. Merging
a pull on a mirror is refused (`mirrored`): merge on the origin, and the next
sync brings back the merge commit it actually made.

**Push-through.** A mirrored repo accepts pushes from the account that
connected its origin — the push travels under that credential, so nobody
else may send it (the same `origin_owner_only` rule as write-through). In
**pre-receive** — before the local refs move — the forge pushes each updated
ref to the origin with the stored credential; if the origin refuses, the
local push is refused with the origin's own message. This is possible because
the pushed objects are still in the push's quarantine directory and git tells
the hook where it is (`GIT_QUARANTINE_PATH` and friends, already forwarded by
`git/hook-protocol.ts`); handing those to `git push` lets pack-objects build
the upstream pack from the quarantine. Doing it in post-receive instead would
mean accepting objects the origin then rejects, leaving the mirror silently
ahead of its origin — the exact divergence this feature exists to prevent.

Every push names an explicit refspec and an explicit
`--force-with-lease=<ref>:<oldoid>` (the three-part form is the only
non-experimental one, and the only one our own background fetcher cannot
defeat). `refs/pull/*` never travels. `remote.origin.mirror` is pinned false
and a refspec-less push is refused by the helper, because
`remote.<x>.mirror=true` silently turns `git push` into `push --mirror`:
force everything and **delete upstream any ref missing locally**. Multi-ref
pushes go `--atomic`, so an origin that would take one ref and refuse another
takes neither. Once an origin is disconnected its mirrors fail closed: they
stay readable and stop syncing, and a push is refused with the reason until
the origin is reconnected ("When a token expires", below).

**Visibility narrows only.** A repo that goes private upstream goes private
here on the next sweep, at once. One that goes public upstream stays as it
was: widening is the owner's decision to make here, never an origin's.

**The fork flow** — contributing to a repository you cannot push to. One
call, `contribute` (`src/actions/contribute.ts`), because it is one
intention: _grab their repo, branch, edit, propose it back_. Split across
five round trips it becomes five half-finished states — a fork with no
mirror, a mirror with no branch, a branch with no commit, a commit nobody
proposed.

What it does, in order:

1. **Ask the origin what you may do.** `getRepo(upstream).permissions.push`
   decides the shape. With push rights nothing is forked: the branch is
   created on the upstream's own mirror and travels there by push-through,
   like any other branch on a mirror.
2. **Find or make your fork.** `forkOrigin` is idempotent: a fork of this
   upstream the account already has is returned as-is (found through
   `origin_repo.fork_of`, or by asking for the conventional name and
   checking its `parent`). GitHub answers a repeat `POST /forks` with the
   existing fork and Forgejo answers 409, so the check has to be ours for
   both to behave alike.
3. **Wait for it.** GitHub creates a fork _asynchronously_ and answers 202
   with a repository that 404s if you ask immediately. `forkOrigin` polls
   `getRepo` with backoff (250 ms → 3 s) for up to 30 s.
4. **Mirror your fork.** That is the workbench: you cannot commit into a
   repository you cannot push to, and the mirror's row remembers the
   upstream in `origin_fork_of`.
5. **Start the branch from the UPSTREAM's base**, not the fork's copy of it.
   A fork made months ago is a snapshot, and committing on top of it
   proposes a diff full of work somebody already merged. `fetchRefFrom`
   (`origins/git-mirror.ts`) fetches the upstream's base ref into the fork's
   mirror with the origin's credential and names no local ref; the branch
   starts at that commit. This is `git fetch upstream` with the manual step
   removed.
6. **Commit, through push-through.** `createBranch` then `editFiles`: the
   objects are written locally, the origin is asked, and the local ref moves
   only if it agreed — the ordinary mirror rule, unchanged.
7. **Open the pull on the UPSTREAM**, with the cross-repository head form
   `head: "<forkOwner>:<branch>"`. Both forges take it. If we also mirror the
   upstream, the created pull is imported so there is a local row; if we do
   not, the number and the origin's URL come back and that is the whole
   truth there is.

**A fork of a mirror** — refining work here before it goes out. A mirror
is the origin's; every push through it lands upstream at once. A native
fork of a mirror (`Fork` on the mirror's page) is the opposite: git is
truth in it and nothing done there reaches the origin. That makes it a
workbench in front of the outside world: the crew forks _it_ and proposes
into it, the person merges there — as many pulls as it takes — and then
proposes the result to the mirror as one pull. Opening that pull
(`headRepo` = the fork, base = the mirror) carries the fork's branch to
the origin first, under the connecting account's credential with the lease
the mirror holds for that branch, exactly as a push through would
(`carryBranchThrough` in `src/origins/push-through.ts`); the origin opens
the pull from the branch it now holds, and the mirror's own copy of the
branch follows. The fork's default branch is refused as a head: carried
up, it would land on the origin's default branch itself, a push rather
than a proposal — propose a branch made for it. Meanwhile the fork follows
the mirror: each sync that moves the mirror's default branch fast-forwards
the fork's, so long as nothing was committed on it directly (`docs/APPS.md`,
"Forks follow their parents").

**Reading is enough to propose.** Carrying the branch into the origin
repository needs push rights there. An account that can only read it — and
anyone at all, for a repository the operator protects
(`FORGE_ORIGIN_DENY_PUSH`) — proposes through its own fork at the origin
instead (`src/origins/fork-route.ts`): the fork it has is found (the
picker's cache, then its two possible names, then the upstream's own list
of forks for one the account owns under any name, `GET
/repos/{o}/{r}/forks`, bounded) or made (`POST
/repos/{o}/{r}/forks`, under `<owner>-<name>` when the account already uses
the name for something else); the branch is pushed into that fork, leased on
where it stands there; and the pull opens on the origin repository with the
head `<account>:<branch>`. Which way is asked of the origin when the pull
is opened (`permissions.push`), and a direct push the origin refuses falls
back to the fork. A protected repository is never pushed to from here at
all — push-through, a carried branch and a branch made on its mirror are
refused (`origin_protected`) — because a branch pushed into a repository
runs its workflows with its Actions secrets, and a pull from a fork runs
them without (Forgejo `services/actions/secret.go:43`). The same fork is
what `contribute` uses on its fork path (`ensureFork`), and a fork of a
mirror whose origin it will reach through a fork says so on its button:
**Propose via your fork**. `test/propose-via-fork.test.ts` runs it against
a real forge serving git behind the fake API.

The `owner:branch` head form is Forgejo's (v15, `routers/api/v1/repo/
pull.go`): `parseCompareInfo` splits the head on its colon (:1092), looks
the owner up (:1098) and takes that owner's fork of the base as the head
repository (`GetForkedRepo`, :1127), whatever the fork is named; the base
needs read access to code and pulls (:1162), the head read access to code
(:1175-1181). Verified live on Forgejo 15.0.9 on 2026-10-16: a read-only
account opened two pulls on a private scratch repository through its fork,
one from a branch and one from the fork's default branch (`<account>/main`),
and the scratch repository never gained a branch.

**Review states.** A review is a _verdict_ on a pull at one commit —
`approved`, `changes_requested` or `commented` — stored in `review` beside
the line comments, which stay in `comment` with `kind='review'`. Two rules
are mechanical: a verdict that carries authority (approve, request changes)
takes **write** access, so "require review" cannot be satisfied by anyone who
can merely read the repo; and **you cannot approve your own** pull.

The gate is `repo.require_review`: `mergePull` refuses `review_required`
unless there is an approval **of the current head** and no request for
changes on it. A verdict carries the `commit_oid` it was passed on, so a push
dismisses it without anything having to remember to — new code is new code.
A request for changes on the current head blocks a merge whether or not an
approval was ever required; one passed on an older head does not.

Threads are the resolution unit: every review comment sharing an anchor is
one conversation, addressed by `anchorId(path, side, line)` — a 16-hex digest,
because the key itself contains a NUL and a path and belongs in no URL. A
writer, or anyone who commented in the thread, may resolve or unresolve it.

On a mirror the origin decides all of it. A verdict is submitted there —
GitHub `POST /pulls/{n}/reviews {event: APPROVE|REQUEST_CHANGES|COMMENT}`,
Forgejo the same path with its own nouns `{event: APPROVED|REQUEST_CHANGES|
COMMENT}` — and imported back keyed on the origin's review id. Sync brings in
everyone else's (`listReviewStates`, one request per changed pull, separate
from the line-comment walk that costs one request per review). `PENDING` and
`DISMISSED` are not verdicts and are dropped rather than mapped to one.
Imported verdicts are collapsed per **origin login**, not per local author id:
every imported row is attributed locally to the connecting user, so keying on
that would turn five reviewers into one.

**Pins.** `pin` rows say which repos the user wants on their machine. The
local client (`src/cli/`) reads them over the API, clones under
`~/src/<host>/<owner>/<repo>`, keeps them fetched, and reports
ahead/behind/dirty. The server never knows local state.

## A token that lacks a scope

Forgejo answers a token without a scope with a 403 that names it (`token
does not have at least one of required scope(s): [read:user]`). The API
client reads that body (4 KB at most) and keeps only scope-shaped words, so
connecting says "This token is missing User: Read." (`missing_scopes`, 422)
and a sync error says "the token is missing Issue: Read" — not "the token
was refused", which a person cannot tell from a wrong or expired one. The
token form lists what a Forgejo token needs and, once the instance is
known, links to
`<host>/user/settings/applications/tokens/new?name=forge&resource=all&scope=read:user&scope=write:repository&scope=write:issue`,
which Forgejo 15 opens with those already chosen; on Gitea or an older
Forgejo the list says what to pick. `test/origin-token-scopes.test.ts`.

## The operator guard

A forge keeps an origin's credential on a machine where agents run, so the
risk is the account a person authorized — never the owner of this forge. On
a *guarded* host — one the operator registered an application for
(`FORGE_ORIGIN_CLIENT_ID`), or one a push rule covers
(`FORGE_ORIGIN_DENY_PUSH`) — every credential is checked after `whoami` and
before anything is stored, on all three ways in (a pasted token, the code
flow, the device flow). Both variables are read per call.

- An account that **administers the instance** (Forgejo's `is_admin`,
  GitHub's `site_admin`) is refused: "`<login>` is an administrator of
  `<host>`. Sign in to Forgejo with your everyday non-admin account and try
  again." (`admin_account`)
- An account that **can push to a protected repository** is refused, with
  the repositories named (`can_push`). The check asks the origin for
  `permissions.push` — the account's real rights, whatever scopes its token
  claims. Every pattern with no `*` is asked about by name (`GET
  /repos/{o}/{r}`, four at a time, however many there are). A wildcard
  walks the repositories the account can see (`walkRepos`): on Forgejo
  `/repos/search?uid=` sorted by id — every repository it owns,
  collaborates on or reaches through a team, every way to push — so a
  repository pushed or made during the walk cannot move into a page already
  read; with no fallback to another listing; and complete only when the
  distinct repositories seen equal `X-Total-Count`, which must not change
  between pages. On GitHub, `/user/repos` oldest first. The walk is bounded
  (20 pages); an account with more, a page that fails, or a count that does
  not add up is refused (`guard_unchecked`) — the guard fails closed. A
  confirmed hit always wins: an account seen to push to a protected
  repository is refused for that (`can_push`), even when another lookup
  failed or the walk did not finish.
- A refusal stores nothing. On the code flow the grant is revoked where the
  provider allows it (GitHub with a client secret); Forgejo has no
  revocation endpoint, so the message says the forge did not keep the token
  and where to remove the grant.

`FORGE_ORIGIN_DENY_PUSH` patterns: `owner/name`, `*` for any run of
characters inside one part, a bare `owner` meaning `owner/*`, case-
insensitive. A bare pattern covers every origin (so it also turns the
administrator check on for every origin); `host:pattern` covers one host.
Unguarded hosts behave exactly as before, so a person who runs their own
Forgejo can still connect it as its administrator.

The walk is also the person's list of repositories: on a guarded host it is
written to the picker's cache at connect, for free.

**Checked again, after it is stored** (`src/origins/credential.ts`). A
grant outlives the rights it was given with, so the guard runs again on
what is already stored:

- **On every OAuth refresh**, on the new token, before it is used: the
  request that needed the refresh fails if the account is refused.
- **By a sweep** on the sync tick: an origin on a guarded host that was never
  checked (connected before the guard, or before the operator named its
  host) at once — so on boot — and every other once a day. One origin per
  tick, half a second between its requests, so the sweep adds a trickle to
  the origin it protects. A connect that passed the guard counts as a check.
- A refusal marks the origin `needs_reauth` with the guard's sentence as
  its reason. From that moment every use of the credential fails — sync,
  write-through, push-through (no git credential is handed out), the crew's
  pulls through it — and Settings → Origins says to re-authorize, with the
  reason. A credential the origin no longer accepts (a grant revoked there)
  is refused at once. A refresh never clears `needs_reauth` — one racing a
  refusal cannot undo it; only connecting again, through the guard, does.
- **Writes wait on a check.** On a guarded host an origin whose account has
  not passed the guard — never checked yet, or a check that cannot run (the
  origin down, a count that moved) — reads and syncs but writes nothing:
  write-through (`origin_paused`), push-through, branches carried up, forks
  and pulls made there, and, in the adapter itself, any request that is not
  a read (`ProviderCredential.writable`). Settings → Origins says
  "Couldn't verify this connection; writes paused" with **Check again**
  (`POST /settings/origins/:id/check`, once a minute per origin). A failing
  check is tried again in 15 minutes; one that has not run for a day refuses
  the origin.
- When each origin last passed lives in its cursor store (`guard_checked_at`
  and friends): a cache — lose it, and the origin is checked once more.

`test/origin-guard.test.ts`.

## When a token expires

A credential dies: a token is revoked, a refresh token is spent, an OAuth
grant expires. The origin is marked `needs_reauth`, and its mirrors stop
syncing — they are **frozen**, still attached, waiting. Settings → Origins
says so on the origin ("2 mirrors are frozen until it is re-authorized") with
a **Re-authorize** link, and the owner's feed carries one decision item.
Re-authorizing is connecting the same account again: the forge finds the
origin that lost its credential and puts the new one on the same row, in
place (`renewOrigin`). Its id does not change, so its mirrors never detach;
a sync starts at once.

The other way out is to disconnect the origin and connect it again — which
is what happened live in #1090. Disconnecting deletes the origin row, and the
schema's `ON DELETE SET NULL` takes `repo.origin_id` with it while the
provenance stays (`origin_full_name`, `origin_remote_id`, `origin_html_url`).
That is a **detached mirror**: frozen like the first kind, but with no origin
left to sync through, and `push-through.ts` refuses every push to it ("reconnect
the origin before pushing") because accepting one would let it drift from an
upstream it still claims. A trigger on that foreign key's `SET NULL` records
the moment in `repo.origin_detached_at` (migration 72); `last_fetch_at` is
when it froze.

**What a person sees.** The repository home and its branches page carry one
quiet block: "This repository mirrors `octo/widgets` at codeberg.org, but
that origin was disconnected on 2026-10-11; it has been frozen since
2026-10-02." Every reader gets the sentence. An admin of the repository also
gets the **Reconnect** form — a select of their own working origins on the
same host and a button — or, when they have none there, the link to
Settings → Origins to connect one. Settings → Origins lists the account's
frozen mirrors and where each came from, and the feed asks the owner to
reconnect each one. A fork following a detached mirror never says it is up
to date with it (`docs/FOLLOWING.md`).

**The one click** is `reattachMirror` (`src/actions/origins.ts`), behind the
form (`POST /:owner/:name/settings/origin/reconnect`) and the API. It
re-attaches only when all of these hold, and says which one did not:

- the repository is a detached mirror (`not_detached`);
- the actor administers it and owns the origin — anything else is
  `not_found`, because reconnecting lends that origin's credential to every
  later sync and push of the mirror;
- the origin lives on the host the mirror came from, read from the
  remembered page or, failing that, the bare repository's git remote
  (`wrong_host`);
- that account can see the repository by the name the mirror remembers
  (`origin_cannot_see`), it is the same repository (`not_the_same_repo`: a
  name deleted and made again upstream is someone else's history, and a sync
  would prune this one into it), and no other repository here already
  mirrors it (`already_mirrored`).

Then the remote is remembered, the repo is linked again (which clears
`origin_detached_at`), the bare repository's remote URL is rewritten if the
clone URL changed, `origin.mirror_reattached` is appended (for the repo's
admins), and a sync starts in the background so the refs move now — the
answer says "syncing", and the mirror's branches follow within seconds.

**Connecting again re-attaches by itself.** After any connect — a token, a
device grant, a code flow — the forge looks for the detached mirrors the
person owns whose host is the new origin's, and re-attaches each with the
same routine. Owns, not administers: re-attaching lends that account to
every later sync and push, so an organization's mirror borrowing an admin's
personal account is that admin's click on Reconnect, never a side effect of
connecting. A refusal never fails the connect: the answer lists
every mirror it tried, re-attached or not and why
(`reattached: [{ owner, name, fullName, refused }]`, `refused` null for one
that came back), and the page's flash says "Reconnected 1 mirror:
trevato/forge-upstream".

Two rules keep a reconnect honest. The origin must be on the same **site** as
the mirror's remembered page — scheme, host and port — because `git.example`
and `git.example:8443` are two servers, and a mirror reattached across them
would sync from the wrong one. And a mirror made before the forge kept the
origin's id for it is not reconnected (`remote_unknown`): it cannot be told
apart from a repository made again under the same name, and a sync would
prune its history into the newcomer's; mirror it again instead.

## Migrate — bringing a repository here for good

A mirror keeps answering to its origin. A **migration** does not: it is a
one-time clone of the whole history into a native repository that is yours
from the first second. No `origin_id`, no remote in its config, no
write-through; after it, this forge is where the repository lives. It is
the "+" menu's **Migrate** (`/migrate`), and `migrateRepo`
(`src/actions/migrate.ts`) is the whole act.

**The source** is one of two things. A repository on one of your origins,
picked from the same list the mirror picker reads (`listRemoteRepos`), is
cloned with that origin's credential — the auth header in the environment,
scoped to its host (`origins/credentials.ts`), never in argv, the URL or the
repository's config — so private ones come too. Or a pasted URL, cloned
anonymously: public repositories only. A URL is `https://`, `http://` or
`git://` and nothing else — `file://`, `ssh://`, `ext::`, a leading `-` and a
URL carrying a password are refused before anything exists, and
`GIT_ALLOW_PROTOCOL` pins the transports again at the fetch in case a
redirect has other ideas. `github.com/a/b` gets the `https://` a person meant.

**The clone** fetches every branch and tag — the mirror's explicit
refspecs, never `--mirror` (every `refs/pull/*`, and a remote marked for
push-mirroring) and never `--single-branch` — straight from the URL, with no
remote configured, under a 120-second wall-clock cap. The source's default
branch is kept (asked with `ls-remote --symref`); a source that never says
keeps the forge's `main`, else `master`, else its first branch. One `push`
event with `via: "migrate"` announces what arrived, so the feed, webhooks
and the default branch's check see it like any push. Everything a person
can get wrong — the URL, the owner, the name (collision-checked like any new
repository), the agent — is refused in words before the repository exists;
what is left for the job is the network. A clone that fails removes the
empty repository it made, so the name is free to try again.

**One click from GitHub.** `/migrate` carries its own "Your accounts"
card: **Connect GitHub** runs the device flow above (no token pasted; it
needs the forge's GitHub application, `FORGE_GITHUB_CLIENT_ID`) and comes
back to `/migrate`, and each connected account has a **Disconnect** that
comes back too. The return is the fixed word `then=migrate`, never a path a
form can choose. Every repository the account can see (owned and its orgs')
is a row — name, a `private` mark, its size as the origin reports it (KiB,
shown in KiB/MiB/GiB), its description — filtered by `?q=` on the server and
live as you type. A row's button is the form's submitter (`name="pick"`), so
one click migrates it with the destination and crew fields as they stand;
the first agent is picked by default, "Nobody" is one choice away.

**The branch the app lives on.** A fork often keeps the upstream's tree on
`main` and the person's app on a branch of their own, so the source's default
is not always the app. A row's **Branches** link (`/migrate?source=…&branches=1`) draws
that repository's branches, each with its last commit — subject, author,
date — read through the origin's API (the first 30 branches' commits; the
rest by name), remembered a minute per account and repository so a reload or
a refused form spends nothing at the origin; a plain visit asks for none of it. The one selected is the branch whose last commit is the
person's and newest (an account login the origin resolved, a GitHub noreply
address with their login, their forge email, or an author name that is one
of their logins), else the source's default. A one-click row with no branch
chosen gets the same rule in the job, over the clone's own tips
(`git for-each-ref`) and the origin's logins (`origins/work-branch.ts`).
That branch becomes the default branch here, the job says which and why,
and the crew's brief names it: start from it, open the pull against it.

**A token that sees public repositories only says so.** A classic GitHub
token without `repo` (its `X-OAuth-Scopes` on `/user`), or a fine-grained one
whose `/user/repos?visibility=private&per_page=1` answers no row, lists no
private repository, and the account's card on /migrate says it in one line:
"This token sees public repositories only, so private ones won't appear",
with **Make a token with `repo` on GitHub** linking GitHub's new-token page (`scopes=repo`
prefilled) and a field for the new one (`POST /settings/origins/:id/token`).
The new token must answer for the same login; the origin keeps its id, its
mirrors and pins, and its repositories are listed again at once. The answer
is remembered ten minutes per origin and forgotten when the token changes
(`origins/token-reach.ts`). The terminal's migrate screen draws the same
line and the new-token page under its rows, and `t` takes the new token into
the same action. The picker's filter narrows the rows as you
type, Enter or the **Filter** button asks the server.

**The conversations come too** — from a connected origin, not a pasted URL
(`origins/carry.ts`). Labels; every issue, open and closed, with its comments
and labels, under its original number; and the open pull requests as pulls
here, on the branches the clone brought — native ones (`origin_head_repo`
cleared), so they review and merge like any other. A pull whose head lived
in a fork is a stranger's code: its head is fetched into `refs/pull/<n>/head`
(the forge's own namespace — no push event, no branch the clone brought is
touched), it keeps `origin_head_repo`, and its check and preview wait for a
writer's **Approve to run here**, exactly as a mirror's do. The job's message
says how many wait. Closed pulls stay behind: their work is in
the history or was turned down. Each body opens with
`> Migrated from [owner/name#n](<original>) by @login on GitHub.` — the link
only when it is http(s), the login reduced to login characters — and the
author also travels in `origin_author`, so every page marks it as theirs on
the origin. One `repo.imported` event (`via: "migrate"`) says so, not one per
row. A refusal part-way keeps what arrived and says so in the job's detail.

**Put a crew on it.** Name an agent and, after the clone, the same job puts
it on the crew, makes the repository an app, sets it autonomous when asked,
and `tell`s the crew one thing: make it run here. The brief is the
importer's — adapt, don't rewrite: declare `run` and `health` in
`forge.json` (and `install`/`test` when the repository has them), listen on
`PORT`, keep persistent state under `FORGE_APP_DATA`, keep behaviour, no
Dockerfile and no compose file (the forge runs processes), and write down
what could not fit. When the app used a database server elsewhere, the
pull says where its rows are and what it uses now, leaves the old database
untouched, and ships a one-shot import script (dump file in, `FORGE_APP_DATA`
out) with the steps to make the dump. No connection string to the old
database is ever committed or read at boot. The crew proposes; a person lands — autonomy included,
exactly as for any app (docs/APPS.md).

A link can prefill the form: `/migrate?from=<host>/<owner>/<name>&crew=<agent>`.
`from` is matched against the full host of each of your origins
(`URL(webUrl).host`: host plus any port, lower-cased — not the display label)
and then `/<owner>/<name>`; a match selects that repository. `crew` selects
that agent when it exists. Either is capped (200 and 64 characters) and limited
to ref characters; a value that matches nothing is ignored and named in one
escaped line. The GET reads the lists the page already loads and starts nothing;
the person still presses Migrate (POST, same-origin checked).
(`src/web/pages/migrate-prefill.ts`)

The clone runs as a job in the mirror's registry (`origins/jobs.ts`, kind
`migrate`, owned by whoever started it — anyone else's is `not_found`).
`/migrate/jobs/:job` follows its stages — clone, issues, pull requests, the
app and the crew's first run — and then lands on the repository, which is
the app's page, with what happened as the flash.

**After a GitHub migration** you choose what happens to the original: leave it
alone (the default), archive it, or keep it as a read-only mirror. The choice is
the "Afterwards" field on `/migrate`, in the terminal's migrate screen, and
`after` (`leave`, `archive`, `mirror`) on `POST /api/v1/migrate`. Archive marks
the GitHub repository archived using the account you connected. Mirror leaves
GitHub untouched at first, then copies later changes on the branches GitHub had
at migration back to it; branches made afterwards, such as the crew's work
branches and pull heads, stay on the forge. If someone pushes to GitHub
meanwhile, the forge stops rather than overwrite them, and the repository's
settings page (and the terminal's status line) says why it stopped and when it
last pushed. "Stop mirroring" there, or `U` in the terminal, ends it and leaves
GitHub as it is. Archiving needs admin
rights on GitHub: without them the migration still succeeds and says the
repository was not archived, so you can do it there yourself. Only repositories
read through a connected origin have an original to change; a pasted URL does not.

**Pulls opened on the mirror come here** (#9011, `src/origins/mirror-pulls.ts`).
Someone who finds the mirror and opens a pull there is not lost: each open
pull on the mirror is fetched (`refs/pull/<n>/head`, vetted and pinned like the
mirror push) into `mirror-pull/<n>` here and opened as a pull on the default
branch (or the mirror pull's base, when it exists here), under the account
that connected the origin. It carries its author's name (`origin_author`) and
a link back (`origin_html_url`), so it is a guest pull: no secrets, no crew,
until a person approves it — unless that author is a trusted source on the
mirror's host (`pull_source`; `guestWaits` asks `foldsIn`, so lapsed trust
waits again). The author and link are written with the pull's first row, so
nothing that hears `pull.opened` ever sees it as an ordinary pull. The fetch
is capped at 200 MiB of new objects (`src/git/capped-fetch.ts`: it lands in a
scratch repository borrowing trunk's objects, and only a fetch under the cap
is moved in). One comment on the mirror pull says where it went. A head that
moves on the mirror moves the pull here while it is open, and clears any
guest approval: the head a person approved is not the one that would run. The mirror is never pushed to except the trunk refs the
mirror push already sends; the comment and a webhook are the only writes. It
runs by event — on boot the mirror is asked once for a webhook on its pull
events (`watch`, Forgejo's `X-Forgejo-Signature` is accepted on
`/api/v1/repos/:owner/:name/origin-hook`, signed with the repository's derived
secret) — and by a sweep every five minutes for anything missed. Both key on
the mirror pull's URL and run one at a time per repository, so they never
make two copies of one pull. `test/mirror-pulls.test.ts`, against the fake
Forgejo.

**Migrate from the terminal.** Press `M` on the dashboard (or pick "Migrate a
repository" in the palette, `ctrl+k`). The list is your connected origins'
repositories, private ones marked; `/` filters it and `u` pastes a URL instead.
Enter on a repository lists its branches with their last commit, your own
newest first and marked "(suggested)", so Enter again takes it; a pasted URL
skips this step. The form asks for name, owner, visibility, agent, autonomy and afterwards
(leave the original alone, archive it, or keep it as a mirror; `tab` moves, `space` changes); `ctrl+d` migrates. The job is a checklist of
stages: `esc` hides it and never cancels, and a toast says when it lands, on the
new repository. It is the same `migrateRepo` as `/migrate` and
`POST /api/v1/migrate`: the chosen `branch` becomes the default branch and the
crew's brief says the app lives on it. The web form takes it too (it lists the
picked repository's branches newest first), as does the API's `branch` field.

A GitHub migration also carries each milestone (title, description, due date,
open or closed) as an issue here, with the due date and GitHub's milestone
number kept in `milestone_origin`; carrying again makes no duplicates. Which
issues belong to a milestone is not carried yet.

## Follow an upstream

A repository can follow a git URL outside the forge (`repo_upstream`,
`core/upstream_follow.ts`; the check is `actions/upstream_follow.ts`). An
admin of the repository does it, on its settings page's **Follow upstream**
card: the URL, the branch (default `main`), and an on/off box; **Check
upstream now** appears once it is on. The URL is `https:` or `http:` with no
password in it — `git:`, `ssh:`, `file:` and the rest are refused at save,
so the vetted-address pin always holds. A host inside the network is checked
as the mirror's fetch is: vetted, and the vetted address pinned.

Every 30 minutes (the server's one-minute timer runs `checkDue`) and on
**Check now**: `ls-remote`, a fetch only when the tip moved into
`refs/upstream-follow/<branch>` — not a branch — and, when the commits merge
cleanly, one pull from `upstream/<tip7>`. One check runs per repository at a
time, the clock's and the admin's sharing one claim; a second is `busy`
(409 in the API). Never a push to the default branch.

**Credentials.** A public upstream needs none. A private one is fetched with
the credential of the origin the admin connected (Settings → Origins), sent
only to the exact https origin it was connected at, as a header in git's
environment — never in the URL, never in argv. Nothing is stored in the
repository. A check's failure message is the remote's stderr with secrets
redacted, shown to admins only.

The About card says "Following <upstream> · last checked HH:MM · N behind",
to admins only. API, all admin-only (anyone else gets 404):
`GET|PUT /api/v1/repos/:owner/:name/upstream` (PUT takes
`{url, branch, enabled}`) and `POST …/upstream/check`.

A followed repository's home shows admins "N commits behind owner/name" (or "conflicts with owner/name: resolve") from the last stored check, with an **Update** button: a same-origin POST form to the settings page's check action that returns to the home, no JS. The terminal's About card (`I`) has the same words as a `behind` row, and `u` is the same update (`behindWords`, `src/actions/upstream_follow.ts`).

A repository can follow an outside git branch (`repo_upstream`, https or
http only, no credentials in the address). The clock checks each following
repository every 30 minutes (`checkDue`); the result is the follow row:
upstream tip, commits behind, the pull carrying the last proposal, and
`error`. In the terminal, a repository's About card (`I`) shows an
`upstream` row (address, branch, last check, standing; `off` when following
is off) to an admin of the repository and to nobody else. `u` checks now,
while following is on, through the settings page's own action. `f` turns
following on or off through `setFollowUpstream`; it keeps the saved address
and branch, and when none is saved it refuses with "set the upstream address
in the web settings first" (the address is set on the settings page). A check fetches only when the tip moved, into
`refs/upstream-follow/<branch>` (not a branch), then:

- **Nothing new:** nothing happens.
- **New commits that merge cleanly into the default branch:** the forge
  writes `upstream/<tip7>` at the fetched head and opens one pull from it,
  as the person who turned following on. A second check with the same tip
  opens nothing, and a proposal someone closed is not reopened.
- **A newer tip while that pull is open:** the pull is moved to
  `upstream/<newtip7>` and its title and body rewritten; the old
  `upstream/<old7>` branch stays, as a person may have built on it.
- **A conflict:** the row's `error` reads `conflict`; no branch, no pull. With
  autonomy on, the check also opens one issue for that head and queues one
  converge run for the crew to resolve it; with autonomy off, the note on the
  row is all there is.
- **A planted branch:** if `upstream/<tip7>` already exists anywhere but at
  the fetched head, the check fails (`squatted`), says so on the row, opens
  no pull and leaves the branch as it was.

## API

```
GET    /go/:code                               anonymous: 303 to a live flow's
                                               verification/authorize URL
GET    /api/v1/user/origins                    list (no tokens, ever)
POST   /api/v1/user/origins                    {host|kind, token}  → discovers, validates
                                               → 201 origin + reattached [{owner,name,
                                                 fullName,refused}]; renews in place
                                                 an account that needs re-auth
POST   /api/v1/user/origins/oauth              {host|kind} → starts device OR code flow
GET    /api/v1/user/origins/oauth/:id          poll a flow (the forge does the polling)
DELETE /api/v1/user/origins/:id                → { revokedUpstream }
POST   /api/v1/user/origins/:id/sync           sync now
GET    /api/v1/user/origins/:id/repos          the picker (cached, ?refresh=1)
                                               each row: mirroredAs {owner,name}|null

  browsing a remote repo live — B = …/origins/:id/browse/:owner/:name
GET    B                                       facts + branches + readme
GET    B/branches   B/tags   B/labels
GET    B/tree/:ref[/*path]                     one level: {type:"dir",ref,path,entries}
GET    B/blob/:ref/*path                       {type:"file",…,encoding,content} | 413
GET    B/commits?ref=&cursor=                  {items, next_cursor}
GET    B/commits/:oid                          commit + parsed diff
GET    B/issues  B/pulls  ?state=&label=&author=&q=&cursor=
GET    B/issues/:number   B/pulls/:number      + body, comments, pull facts

POST   /api/v1/user/origins/:id/fork           {fullName} → 202
                                               {remote, existed, job, mirroredAs}
POST   B/contribute                            the fork flow, from a browse
POST   /api/v1/repos/:o/:n/contribute          the fork flow, from a mirror
POST   /api/v1/user/origins/:id/mirror         {fullName, name?} → 202 {job}
GET    /api/v1/user/origins/:id/mirror/:job    poll one job
GET    /api/v1/user/origins/:id/mirror/:job/stream   SSE: mirror.<stage>, ends on done
GET    /api/v1/user/origin-apps                registered OAuth apps (no secrets)
POST   /api/v1/user/origin-apps                {host, clientId, clientSecret?}
DELETE /api/v1/user/origin-apps/:id
POST   /api/v1/repos/:o/:n/sync                sync this mirror now; on a fork, take the
                                               parent's updates (fast-forward or merge;
                                               404 not_a_fork, 409 conflict + files + message)
POST   /api/v1/repos/:o/:n/origin/reconnect    {originId} → repo JSON; re-attach a
                                               detached mirror (admin token, repo
                                               admin, own origin; else 404/422 code)
GET    /api/v1/user/pins  ({items, next_cursor}; ?limit=1..200, ?cursor=)  PUT/DELETE /api/v1/user/pins/:owner/:name

POST   /api/v1/migrate                         {source: {url} | {originId, fullName},
                                                owner?, name?, visibility?,
                                                branch?, crew?: {agent, autonomous}}
                                               → 202 {repo, job}
GET    /api/v1/migrate/:job                    poll one migration (its starter only)
GET    /api/v1/migrate/:job/stream             SSE: migrate.<stage>, ends on done
```

Everything under `/api/v1/user/origins` and `/api/v1/user/origin-apps` needs
the **account**: a same-origin session, the password, or an explicit `admin`
token. A `ro` or `rw` token is refused — otherwise a leaked repo-write token
escalates into "read this person's GitHub credentials by proxy". That covers
the browse routes too: they read another forge with this account's
credential, which is the same authority as spending it. Repo-level sync and
pins take the ordinary `rw` floor; so does a migration from a URL, while one
from an origin takes `admin` — it spends the origin's credential. Its
refusals are 422 `{ error, message }`: `invalid_url`, `no_such_origin`,
`unreachable`, `no_such_agent`, `invalid_branch`, and the new-repository codes (`name_taken`,
`invalid_name`, `forbidden_owner`).

A contribute answers 201 with
`{ via: "fork"|"direct", repo: {owner,name}, forkFullName, branch, commit,
pull: { number, htmlUrl, local } | null }` — `repo` is where the branch landed
here, `forkFullName` the fork at the origin (null on the direct path), and
`pull.local` the imported row when we mirror the upstream too. Its refusals
are the ordinary origin codes plus `fork_timeout` (504 — the origin took the
request and the fork has not appeared), `mirror_failed` (502) and the edit
codes `editFiles` already returns.

Review states and threads, on any repo:

```
GET    /api/v1/repos/:o/:n/pulls/:n/review-states   the verdicts
POST   /api/v1/repos/:o/:n/pulls/:n/review-states   {state, body?, comments?} → 201
POST   /api/v1/repos/:o/:n/pulls/:n/approve-here   a writer lets an origin fork's current head run here → 201
GET    /api/v1/repos/:o/:n/pulls/:n/threads         anchors + resolution
POST   /api/v1/repos/:o/:n/pulls/:n/threads/:anchor/resolve
DELETE /api/v1/repos/:o/:n/pulls/:n/threads/:anchor/resolve
PATCH  /api/v1/repos/:o/:n                          {requireReview}
```

`…/reviews` is unchanged and still the _line comments_ — a sibling path
rather than a mode of the same one, because a comment on a line and a verdict
on a change are different things with different rules, and one path meaning
two of them behind a query parameter is the shape that gets called wrong.
Each line comment now carries `anchor`, the thread it belongs to.

A review that comes with line comments is still one call: `comments` on
`…/review-states` is a list of `{path, line, side, body}`, at most 50, posted
before the verdict and all or none — one anchor outside the diff refuses the
whole review with `bad_anchor`, and the message says how an anchor is written.
This is the one way the crew's reviewer brief posts a review.
`GET …/pulls/:number` gains `status.reviews:
{ approved, changesRequested, required, mergeable }`.
`GET …/pulls` and `GET …/pulls/:number` carry `mergeable` (does the head merge
into the base's current head) and `conflicts` (the paths that stop it) on open
pulls only; a merged or closed pull leaves both out.

Repo JSON gains `origin: { originId, kind, fullName, htmlUrl, host, lastFetchAt,
fetchError, detached, frozenSince, detachedAt } | null` — a detached mirror
keeps an `origin` with `detached: true`, `originId` and `kind` null, and the
times it was disconnected and last fetched, so it never passes for a native
repository — and `pinned: boolean`; issue/comment JSON gain `originAuthor`, `originUrl`;
pull JSON gains `originHeadRepo`. Errors specific to this surface:
`mirrored` (409), `origin_owner_only` (403), `origin_refused` (409),
`origin_unreachable` (502), `origin_unauthorized` (502, the origin refused
our credential — reconnect it), `rate_limited` (429) and `too_large` (413) —
so a client can tell "the forge said no" from "the origin said no", and
"come back later" from "this will never work".

Events added: `origin.connected`, `origin.refreshed`, `origin.needs_reauth`,
`origin.disconnected`, `origin.app_registered`, `origin.mirror_reattached`
(on the repo, for its admins: `{ origin, fullName }`), `repo.mirrored`,
`repo.imported`, `repo.pinned`, `repo.unpinned`, `repo.forked`
(`via: "origin"` for a fork made at an origin), `pull.reviewed` (with
`state` for a verdict, `path`/`line` for a line comment) and
`pull.thread_resolved`. Imported activity reuses the
existing kinds (`push`, `issue.opened`, `pull.opened`, `pull.merged`,
`issue.commented`, …) with `via: "origin"` in the payload. None of them ever
carries token material, a `state`, or a `code`.

## Known limits

- **Write-through is inline, not queued.** The request waits on the origin
  (bounded by a 20 s API timeout). A durable job queue would decouple them
  and make retries idempotent; it would also mean a comment that appears
  "pending", which is a worse lie than a slow request. Revisit if a slow
  origin becomes the common case.
- **Comments are fetched per changed item**, not through the repo-wide
  `/issues/comments?since=` sweep both forges offer. Correct, and O(changed)
  rather than O(all) — but the repo-wide sweep is one request instead of N
  and is the obvious next optimisation.
- **A live browse cannot search.** Neither forge offers a label/author/title
  filter both spell the same way on a list endpoint, so those narrow the page
  we fetched. Fine for a look; the mirror is what makes a repo searchable.
- **Fetch progress is stage-level, not percentages.** `git fetch --progress`
  writes them to stderr, but `runGitCapture` buffers stderr whole; streaming
  it wants a spawn path of its own, and "fetching git objects" was worth more
  than that today.
- **No LFS.** A mirror of an LFS repo has the pointers, not the objects.
- **Contributing needs a workbench.** `contribute` mirrors your fork (and, on
  the push-rights path, the upstream) if it is not mirrored already, so the
  first contribution to a large repository pays for a clone and an import.
- **A review's line comments do not travel with its verdict.** Submitting a
  review through the origin sends the state and the body; anchored comments
  are still posted one at a time. Both forges accept comments inside the
  review payload, which is the obvious next step.
- **The guard's window is a day.** An account that gains push rights to a
  protected repository keeps its credential until the next refresh or the
  next daily sweep, whichever is first.
- **Key rotation keeps one key behind.** A sealed value is
  `v2:<keyid>:<iv>:<ciphertext>`, keyid the first 8 hex of SHA-256 of the key
  that sealed it. To rotate, move `secret.key` to `secret.key.old` (keep it
  0600 — the forge refuses either file wider than that) and restart: a fresh
  `secret.key` is minted, new values seal under it, and `open` uses whichever
  key a value names. Values from before the format change (`v1:<iv>:<ct>`)
  name no key and try the current key, then the old one. Nothing re-seals old
  values yet, so `secret.key.old` must stay until every token has been
  rewritten (reconnecting an origin does it); delete it and those values come
  back `bad_key`, as losing `secret.key` did before. A snapshot carries only
  `secret.key`, and the HMAC keys derived from it (passports, visitor links)
  change with it.
- **DNS rebinding is not closed.** The SSRF policy checks address _literals_;
  a hostname that resolves into a private range still gets through, because
  pinning the resolved address needs a connect hook Bun's `fetch` does not
  expose. The operator allow-list is the mitigation.
- **Milestones, reactions, projects, and GitLab** are out of scope. The
  adapter shape fits GitLab; it is one more file when wanted.
