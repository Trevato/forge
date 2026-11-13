# A tour of the forge

This document describes each page and screen beyond the studio, one feature per
section. It is for people who want every way to reach a feature: the web, the
terminal over SSH, the API and the MCP.

Related documents cover the rest: [`STUDIO.md`](STUDIO.md) for the main pages,
[`CREW.md`](CREW.md) for the crew, [`APPS.md`](APPS.md) for apps,
[`ORIGINS.md`](ORIGINS.md) for connected forges, [`ASKS.md`](ASKS.md) for
questions waiting on a person, and [`OPERATING.md`](OPERATING.md) for running it.

## Live in the terminal

`ssh` into the forge and you get the whole thing — repositories, code, issues,
pull requests with a real diff viewer, review comments, merges, settings,
tokens and keys — as a keyboard-driven terminal app. The same port serves git.

```sh
ssh -p 2222 localhost                        # the terminal UI
git clone ssh://localhost:2222/you/hello.git # git, same port
ssh -p 2222 localhost tell make the header blue # tell the crew in one line
```

`tell <words>` takes the rest of the command line as given (no shell expansion; control characters are refused) and tells the crew in the forge's own repository, as the account the key belongs to, through the same action as the web composer. It prints the told line and the full address of the issue, and exits 0; an unknown key, nothing said, too much, or an unverified email prints the reason on stderr, records nothing and exits 1. (Quote the words if your local shell would expand them.) When SSH is on, `/llms.txt` and `/api/v1/here` (the `ssh` field of the "tell the crew" action) name this exact command, so an agent finds it without being taught; with SSH off they say nothing about it.

On an app's login, `ssh -p 2222 notes@localhost tell make the header blue` goes through the app terminal's gate (an app you may not enter answers `no app named notes`, and nothing is recorded) and tells the crew of the app's repository, with the app's production address as where it was said: the issue body and `/asked` show `Told from <address>`.

An app's open pulls, newest five first, one line each (`#n title · green|red|running|none`), need no tty: run `pulls` on the app's login — `ssh <app>@<forge> pulls`, with the app's page printing the exact command as `FORGE_APP_SSH` (the terminal is off when that is unset). A private app answers only a key its gate admits; sealed pulls show to their author, writers and the crew (`src/apps/door_pulls.ts`).

The app's `/__forge/` door on its own host lists the same five pulls with their check word (`#n title · check green`). A running, asleep or dormant preview links to itself, any other pull to its page on the forge. Who sees which is the rule in `src/apps/door_pulls.ts`; a stranger at a private app gets the same 404 as for an unknown app. When more than five are open the door says so in one line; the rest are on the forge.

A big repository clones over either transport. To skip its large files until a
checkout needs them, run `git clone --filter=blob:none <url>`. See
[`docs/GIT.md`](GIT.md).

Your SSH key is your identity. A key the forge knows signs you straight in; any
other key browses public repos as a guest and can press `s` to sign in with a
username and password — which links that key to your account, so the next
connection is instant. `j`/`k` to move, `enter` to open, `esc` to go back, `/`
to filter, `?` for the keys, `:` for the command palette, `t` for the theme.

**Secrets.** For a forge admin, `:` → *Secrets* lists sealed secret names (never values); `a` sets one, `d` removes one after a confirm, `s` changes the place. See [OPERATING](OPERATING.md#secrets-in-the-terminal).

**Run logs.** In the terminal, `enter` on a run (in the runs list, a pull, an issue or the deploys) opens its log: the state line, then the last 200 lines, scrolled to the end and following new lines while the run is queued or running (`j`/`k` and the page keys scroll; scrolling up keeps your place). A log you may not read is "Not found", as `run_log` and the REST route say. `o` there prints the web address (`src/tui/screens/runlog.ts`).

**Milestones.** `:` → *Milestones in a repository* → `owner/name` lists a
repository's limbs in the order the crew takes ready work (`enter` opens a
limb's own limbs). A person who administers the repository presses `r` to
Raise or `l` to Lower the limb under the cursor: a preview of the new order
and of the top of the ready list first, then `enter` to apply (`esc` backs
out), then `u` to undo the last move. `p` hands the limb to the planner to
re-plan as fewer, larger pieces: it lists what the planner will be given, then
`enter` confirms; the row reads *with the planner*, and `p` takes it back
until the planner starts. It is the same fleet operation the web
milestones page uses, and a move is heard by that page when it is open.
Anyone else sees the order and no keys to change it; a guest sees only what
the web shows them. Whoever may see owner facts also gets two lines under
the list for the limb under the cursor: **Cost and landed** (dollars spent,
changes landed) and its costliest three issues; a reader or guest sees none.
The web page has the same *Cost and landed* section on a milestone, and the
milestones API and MCP carry it as `spend` (`usd`, `landed`, `costliest`),
owner only.

The milestones page's `Server-Timing` names what a plan cost when it had to be
built: `plan-graph`, `plan-crew`, `plan-week`, `plan-spend` and `plan-limbs`. A
plan kept from an earlier request builds nothing, so those names appear on the
request that built it and not on the ones it served; `plan` is the whole phase,
which on a kept plan is the one stamp read that says nothing changed. That stamp
is itself kept while the forge's write clock has not moved.

Working on the UI itself? `bun run src/tui/main.ts --user alice` runs it over
stdio against your local data directory. That `--user` flag is a development
convenience and exists only there: over SSH, the key decides who you are and
nothing else can.

## The home

On a forge made for a client (one that was spawned, signed in by its claim
link), the home is their apps, one plain sentence each and one more saying
whether its agents are working, about to start, or waiting: no map, board or
settings until asked. `/?all=1` is the whole home, and its "Just my apps" link
comes back. Each app row also says what its agents are on ("Working on: …")
and what was last finished on it ("Finished 3 days ago: …", its newest merged
pull however old, read for all rows in one query); an app with neither says
nothing more. Both doors show both lines: the terminal's first screen opens
with the same lines, worded by the same helpers (`src/core/client-apps.ts`).

Under the figures, an admin's home, the terminal's dashboard and its Flow dialog carry one vitals line (#5935, `src/flow/vitals.ts`): open pulls, opened and landed in 1 h and 6 h, and conflicted, against #5924's targets; the autonomy tick line says the same as `pulls` (and `offTarget` when a target is missed). The MCP `flow` tool and `GET /api/v1/telemetry/flow` carry it as `vitals: { says, misses, … }`; the tool's description is unchanged because `tools/list` is at its size ceiling, so an agent finds `vitals` in the result, not the listing. An agent reader's counts cover public repositories only.

Below it, one parked line (#6471, `src/flow/parked.ts`): the open issues whose newest comment is the crew's `Parked by the crew` note, counted by that note's time over the last 24 h and 7 d, with the newest three named. The terminal's Flow dialog shows it, and the MCP `flow` tool and `GET /api/v1/telemetry/flow` carry it as `parked: { says, day, week, newest }`; an agent reader's counts cover public repositories only.

Home shows nine figures first, from `src/flow/kpis.ts`: shipped per hour (with
a 24 h sparkline), the live version and since when, the median check time, the crew builders
running of their slots, and the crew's spend today of the forge's daily
ceiling (`FORGE_CREW_CEILING_USD`; without one, the spend alone and
`no ceiling`), and the age of the last off-box backup (the newer of the
mirror's newest snapshot, `mirror/state.json`, and the newest that landed in
a destination that is a bucket, `snapshot/state.json`; `src/snapshot/off_box.ts`; `3 h ago`, the exact time in its title), linking to
`/settings/backups`. The spend tile links to `/settings/crew`, where the meter is.
The backup tile past 24 hours, or with none (`never`), takes the card's existing
`data-tone="attn"` and says overdue in its label.
The last three (`src/flow/reach.ts`, the `reach` board source's rows) are
reporting browsers (`5 today`, `31 in 7 days`), accounts (`1 of 2`, seen today) and
page speed (the slowest quarter's page load over 7 days, and `LCP 2.4 s · INP 180 ms`,
LCP and INP, the main content and a tap), from the page-view beacon. Each links to
the Reach starting board (`/boards/reach`). The visitor hash rotates daily, so
the 7-day reporting browsers is each day's distinct count summed.
They count every repository, so only a site admin sees them, on both doors;
nobody else does, and neither does the lean client home. On the web each is a
card linking to `/board`, `/releases`, `/boards` or `/boards/reach`. The terminal's first screen
shows the same nine as lines above the forge strip (`kpiLines` in
`src/flow/kpi_words.ts`). They are read when the page or screen loads and
do not refresh on their own.

A client's first screen offers "Ask for something" on each app they may direct
(`mayDirectCrew`): on the web a link to `/:owner/:name/tell?from=/&ask=1` (no
script), in the terminal the `t` key on the app under the cursor. Both go
through the same `tell()` and answer "Sent. The agents will pick it up."; the
web returns to `/` with that line.

An app that is running also shows "Open" (web: a link to
`/:owner/:name/app/production/open`, the apps page's own) and, in the terminal,
a "(running, o opens it)" marker with `o` showing its live address to open or
copy. Both read `live` on the row from `clientAppRows`, which is set only while
production runs; an app that is not running offers neither and says nothing
about why.

## Asked, review, a client's forge and the family

What you asked for: `Ctrl+K`, then **Asked**, is `/asked` in the terminal — your
thoughts, then the issues you can write to that are not shipped, oldest first,
as MCP `asked` defaults to. `s` cycles not shipped → flagged → all and `o` flips
oldest/newest first, the title saying which; each row says the ask's state
(waiting, building, shipped, closed) and stale or flagged in MCP's words. The
rows keep MCP's order in every view, so the terminal and an agent read the same
list; the web page `/asked` groups what needs you first instead
(`j`/`k` move, `enter` gives the issue's web address, `r` refreshes). It is read
only, shows a guest nothing, and names nothing of a placement in a repository
you cannot read.

Review: `/review` lists the asks waiting on you, one row each (title, repository,
age, why, and the crew's advice or that it has not advised yet), newest first. A pull's row also carries the check verdict for its head (the pull page's badge: passed, failed, running, cancelled, or none) in the row's trail, and, when its repository is an app, an "Open the preview" link under it (shown for any app, even before a preview is deployed); and, when the pull has a look the viewer may fetch, its preview thumbnail beside production's under that (sized, lazy, never inside the row's link; the pull's is the only link, named for a screen reader, and production's is a named picture; a viewer who may not fetch it sees none); all of it comes from the database, never git. The row's trail also says the pull's size (`3 files changed, +40 −7`), kept per base and head commit (`src/web/studio/review_evidence.ts`); a request never waits on git: until the stat is kept the row says "Diff loading — reload for the size" while the app computes it in the background (at most 4 at once, stopped by closing the app), and a failed stat says "Diff size unavailable" and is not asked again for a minute, so a bad pull cannot spawn git on every visit. Visits while a stat is running share it. Each row also carries its actions under it, as plain form POSTs to `/review/act` (same-origin checked, `rw` scope): on a pull **Merge** (through the same landing gate as anywhere, so a red or unreviewed head is refused with the gate's sentence), **Close**, **Request changes** (with a text box) and **Reply** (with a text box); on an issue **Close** and **Reply**. After an action the page answers 303 to `/review#<the next ask>` (the first that followed it and still waits, else the first left, else `/review`), and the acted ask is gone; a refusal comes back to the same row with its reason. Keys: `j`/`k` move between rows, and on the focused row `m` merges, `c` closes and `r` jumps to the Request-changes box; keys are ignored while a text box has focus, and `?` lists them. `/asks` links to it, and signed out it sends you to sign-in. The terminal has no page of its
own for it: the same asks are the dashboard's On you card (acting from the terminal is tracked in #5189).

Stale asks: Home's "N waiting on you", `/review`, the MCP `asks` answer (`waiting: { count, stale }`) and the terminal's On you card all count one set (`src/web/studio/review_set.ts`): asks waiting on you, less those older than 30 days. Those fold into `N stale, archive?` (web: a button that opens the bulk-dismiss preview, and nothing is dismissed until you confirm there; terminal: press `Z` on the On you card for the same preview, then Archive; `u` undoes it for a day). One step takes the first 100; the label says so when there are more. The forge's own needs are not in the count: Home shows them above.

A client's forge: `Ctrl+K`, then **New forge** (any signed-in person's, as the
page is), is `/forges/new` in the terminal — name, for whom, what it is for,
apps to fork (`owner/name`, comma-separated), a fresh one-line app, model key
(hidden as typed), API base URL, budget, how it follows the code and a size (`small` by default, not sent; `medium` or `large` is; left, right or space choose), through the same `spawnDoor` as the
page, `POST /api/v1/forges` and the MCP `spawn`. `Ctrl+P` shows the plan and
makes nothing (it shows a Size line when one is chosen); `enter` on the plan spawns, and the claim link is shown once, in
a dialog, never kept.

An organization for a client's apps: `Ctrl+K`, then **New organization** (a
signed-in person's, never an agent's) asks for a name and calls the same
`createOrg` as `/organizations/new` and the MCP `org_create`. A taken, reserved
or invalid name is refused with the same words on all three
(`createOrgWords`, `src/actions/orgs.ts`) and stays in the field to fix. Once
made, the screen says where it lives, and `n` opens New repository with it as
the owner.

The family across forges: `:` → Family in the terminal, `/family` on the web,
`GET /api/v1/family` and the MCP `family` tool all give the same view. The
forge that sent this one is shown to anyone; the forges it sent, only to a
site admin (docs/SPAWN.md, "The family across forges"). Each sent forge also
says how many of its apps run and names those that do not ("1 of 2 apps
running — bakery asleep").

## Signing in

Passkeys: Settings → Passkeys lists, adds and removes them (several per
account; `src/auth/webauthn.ts` verifies, no dependency, `none` attestation).
The sign-in page's "Sign in with a passkey" gives the same HttpOnly session a
password does. Lost your device? "Lost your device?" on the sign-in page leads
to `/recover`: give the email on your account and, if it is verified, a link
that lasts 30 minutes and works once registers a new passkey and signs you in.
The relying party is the address the browser used (or
`FORGE_URL`), so a passkey does not follow a forge to another hostname.
Where you are signed in, and signing a browser out, is on `/settings`, MCP
`sessions` and the terminal's **Signed in** command (`d` asks, then signs the
selected browser out); see `docs/CREW.md`, "Where you are signed in".
Sign-up is a username and a password of at least 12 characters (`/signup`, `POST /api/v1/users` with `{username, password, email?}`, the terminal), hashed with argon2id; the email is optional and, when given, gets the verify link (an account with none has nothing to prove). A passkey (`src/web/pages/signup-passkey.ts`, which does take an email) is offered beside the password. Nothing in the path touches an edge, parent or Forgejo account. An operator can still refuse password sign-ups with `passkeyOnlySignup`. The owner claim of a spawned forge (`/claim`, `web/pages/claim.ts`) takes the same: a username and a password with the email optional, or a passkey (which needs an email; challenges from `POST /claim/options`), and a claim with neither a long enough password nor a passkey is refused without spending the link. An admin's everyday account (`web/pages/everyday.ts`) still makes its account with a passkey only (`web/passkey-ceremony.ts`, challenges from `POST /settings/everyday/options`): it reads no password, and without JavaScript the page says a passkey needs it.

Password checks are bounded (`src/core/hash-gate.ts`): at most 4 argon2 verifications run at once, and a password over 1024 bytes is never hashed and cannot be set (sign-up, claim and change-password refuse it with "Use 1024 bytes or fewer."). A check over the cap is refused at once, not queued: the caller sees the same `throttled` answer as a full sign-in window (429 with `Retry-After: 1` on HTTP Basic, the API and the sign-in page, "try again" in the terminal; an over-long Basic password is a plain 401), and the attempt is given back to the sign-in windows. The 4-hash cap is a deliberate trade-off: an attacker who keeps 4 hashes busy can make real sign-ins get "try again in 1s"; the per-source sign-in window is what limits how long they can.

A forge with a parent (`FORGE_PARENT_URL`, or the `upstream` in a spawned
forge's `parent.json`) lists the parent under "Link an account you have" on `/signin`. The forge
registers itself once at the parent's `/oauth/register` (the client id is kept
in `rp_client`), sends the person through the parent's authorize page with
PKCE, and on return checks state (also bound to the browser by an HttpOnly
cookie), nonce, `iss`, `aud`, `exp` and the ES256 signature against the
parent's JWKS (`kernel/jwt.ts`; keys are cached ten minutes and an unknown
`kid` refetches them once a minute at most). The parent's `sub` — never the
username — maps to a local account that is already linked to it; a `sub` nobody
holds makes no user and ends on `/signup` (#2883)
(`core/federation.ts`; `http/rp.ts` has the two routes). No dependency added.
The parent's answers are read by bytes and refused past 16 KiB (64 KiB for the
key set), and starting a sign-in is throttled like a password attempt.
An account made this way has no password, so the terminal's username-and-password
door (`s`) cannot let that person in. They add an SSH key under Settings → Keys
once signed in on the web; after that the terminal signs them straight in as
that account, as for anyone with a key.

In the terminal the palette's `SSH keys` (ctrl+k) lists your own keys; `a` adds one (a title, then the authorized_keys line), `e` renames the selected key (prefilled with its name; 1 to 64 printable characters, so each key can say which machine holds it; a name added from any door is fitted to the same rule, so the prefill always renames) and `d` removes the selected key after a confirm that warns when it is this session's key. Refusals read in MCP `ssh_keys`'s words (`keyWords`). Renaming is terminal-only for now: the web's Settings → Keys and MCP `ssh_keys` add and remove but do not rename.

Beside it the palette's `Passkeys` (ctrl+k, people only, not agents or guests) lists your own passkeys, read only: each row is the name, then `added YYYY-MM-DD, used YYYY-MM-DD` (or `used never`). The head line says it is read only and points at Settings › Passkeys to add or remove one; with none it reads "None yet. Add one on the web: Settings › Passkeys." (`src/tui/screens/passkeys.ts`, the same rows as MCP `whoami_can kind: passkeys`).

## Page-view beacon

Every page links one static, immutable script (`src/web/beacon.ts`, under 2 KB, no dependency) that sends, once per page view with `sendBeacon`, the route's path, TTFB, load time, LCP, INP (the worst interaction) and CLS to `POST /_measure`. The route is same-origin only, validates every field, caps the body at 512 bytes and the rate per client, and answers 204. Reports land in `page_vital` (bun:sqlite) keyed by route *pattern*; no IP and no user agent string is stored. A unique visitor is a hash under a salt that rotates daily (yesterday's salt is deleted), rows are kept 90 days. Do-Not-Track and the `forge_measure=off` cookie send nothing, and the server stores nothing for them either. The CSP is unchanged: the script is nonce'd like the shell's.

### How long the golden path took

An app's repository home wears the pace on its app strip, the terminal's **Deploys** screen shows it under the title, `/apps` (and any shelf of apps) says `first preview 14s` in each row's meta line once one has served (one grouped query, `firstPreviews`; the terminal has no apps list of its own to carry it), and `GET /api/v1/repos/:owner/:name/app` returns it as `firstPreviewMs` and `firstProductionChangeMs`. It measures milliseconds from New app to the first preview that served, and from New app to the first production deploy that began after the first merged pull; a figure is left out until it exists. Anyone who can read the repository sees it (`goldenPath` in `src/apps/golden_path.ts`, `appPace` for the terminal).

### Every app's visitors

An app made from the template ships the same beacon as `static/beacon.js`, posting to `POST /__forge/measure` on the app's own host. The forge answers that door itself (`src/apps/measure.ts`), before the app is woken: same-origin only, 30 reports a minute per client and 600 per app (429), a body over the cap is a 413, and a private app or a sealed pull's preview refuses anyone its gate refuses. The app is the host's, never the body's. Production reports are kept in `app_vital` (`src/apps/vitals.ts`, TTFB, load, LCP, INP and CLS, a visitor hashed under the day's salt, no address, kept 90 days and removed with the app, at most 20,000 rows per app a day); previews store nothing. Only Do-Not-Track opts a visitor out on an app's host: the `forge_measure=off` cookie is set on the forge's host and never reaches an app's. Read the numbers (visitors today and over 7 days, p75 TTFB, load, LCP, INP and CLS) on the app's settings page under **Visitors and speed**, or as `vitals` in an admin's `GET /api/v1/repos/:owner/:name/app`. Both doors show them only to people who administer the repository (`appVisitors` in `src/actions/apps.ts`), so a reader or an anonymous caller sees no `vitals`. The page also draws p75 load for each of the last 30 days as a sparkline (server-rendered, no script); a day with no reports is a gap in the line, not a zero, and an app with none in 30 days says so in words. The same 30 values, oldest first with `null` for a silent day, are `vitals.loadDays` in the API. In the terminal all five are on the second line of the app's **Deploys** screen over ssh, and a third line there shows the 30 days as block characters with `·` for a silent day, then the range.

A writer of the app's repository redeploys production from the terminal's **Deploys** screen with `D` and stops it with `S`, each after a one-line confirm that names the app and production. They are the page's and MCP `app_deploy`'s actions (`redeployEnv`, `stopEnv`), answered in the page's words (`src/actions/env_words.ts`). The title line shows production's state, a stopped production offers `D` only, and a reader sees neither key.

The app's admin also sees its own domains on that screen, one line with each domain's state (`live` or `waiting for DNS`), and presses `n` for the domains screen: `+` adds one, `c` checks the selected one's DNS proof now and says the record still needed, `-` removes it after `remove <host>? y/n`. They are the settings page's and MCP `app_domains`' actions (`src/actions/domains.ts`), answered in the page's words (`src/actions/domain_words.ts`); anyone `listAppDomains` refuses sees neither the domains nor `n`.

A forge admin takes a snapshot from the terminal's **Resilience** dialog (`ctrl+k`, Resilience) with `n`, brings the off-box mirror level with `l` and runs a restore drill with `r`, each after a `y/n` asked on the dialog's first line. They are the Backups page's buttons' and MCP `snapshot_now`'s and `mirror_now`'s actions (`src/actions/backups_now.ts`, `drillNow` for the drill), so every door says the same words, and the drill's verdict is the Backups page's; the dialog lists the three newest snapshots, newest first (or that they could not be read), and re-reads them after each. The three keys are shown only to a forge admin, and while one action runs none of them is offered. Nothing names a key or a secret. Anyone else has no Resilience command, and the actions refuse them with `not_found`.

A forge admin signed in at the terminal who has not yet chosen how to work day to day sees one muted line at the head of the dashboard, the ask of the web home's one line in its words (`askForEveryday` in `src/core/everyday.ts`): `E` opens Settings on the web to make the everyday account, because that account is made with a passkey and a terminal cannot hold one, so the terminal never makes it itself; `K` keeps working as admin through the same `keepAdmin` the web reads, so neither door asks again. Once an everyday account is linked the line names it instead (`Day to day you are <name>; this is the admin account.`). Anyone who is not an admin, and an agent, sees no line and neither key; `k` still moves the cursor.

The `app_vital` board source (`src/boards/sources.ts`) charts those reports: one row per app per day with `app` (the app's id), `day`, `load_p75`, `inp_p75` (ms) and `reports` (rows kept that day), the percentiles nearest-rank per app per day as `reach` does. `max` or `avg` over several days summarises daily percentiles, not the percentile of the whole range. Its rows belong to the app's repository, so a query sees only the repos in its scope. Today boards query with `repoIds: "all"` (`src/web/pages/boards.ts`) and only a site admin reaches them; no non-admin scope exists, so nothing yet applies the settings page's `canAdmin` gate per repository, and whoever builds one must. Days older than the 90-day trim are gone, not zero. The slug and the visitor hash are not columns. No dependency was added. Left out: a starting board for it; pick `app_vital` in the `/boards` source picker.

`reach` is a boards source for an admin only (anyone else gets 403, an agent too): `visitors` per day, `lcp_p75` and `inp_p75` per route per day, `server_p50` and `server_p95` per route per day (the beacon's time to first byte, the only per-route server timing the forge keeps), and `accounts_active_1d`, `accounts_active_7d` and `accounts_total` as of now. Filter by `metric`, group by `route` or a time bucket. Percentiles are nearest-rank within one route and day, so a `max` or `avg` over several days is a summary of daily percentiles, not a percentile of the period. Account activity comes from a session's last-seen time, so it is a count as of now, not a history. No dependency was added.

## The board's notes

`/board` opens on its panels. Everything that is not a panel — the forge's
health (admins), a planner that declined and waits for you, agent pulls that
wait for your review — is folded into one quiet line under the title, "3 notes
· 2 need you". It is closed by default; click it (or Tab to it and press
Enter) to open the list in place, and it stays open across live updates. A
declined planner has its answer box right in its note. The crew's own
housekeeping (an issue parked twice) is not a note; it is on `/map`. The
terminal's first screen says the declined and review-wait notes too, one line
each, under the forge strip; a list cut to three says "+N more".
The line is the shared `.quiet-details` disclosure, and the "need you" count
carries the attention dot.

A fork ahead of its parent offers its commits upstream: on its home a signed-in reader of the parent sees "Offer N commits upstream" (into the new-pull form with both branches chosen) or "Offered in #M" once a pull is open; a writer who has the Following card gets its "Propose upstream" instead, one route not two. In the terminal the fork's About card (`I`) has an `offer` row and `o` opens the same pull form (or the open pull). Both read `upstreamOffer` (`src/actions/offer_upstream.ts`), the open pull by one SQL lookup.

## Long threads

An issue or pull page renders the opening post and its newest 50 comments
(`THREAD_WINDOW`, `src/core/issues.ts`) with the state-change lines between
them; above them a plain link, `Show N earlier items`, goes to the same page
with `?all=1` (other query parts kept), which renders everything, with no
JavaScript. N counts state-change lines as well as comments. A comment's own
anchor is `#c-<id>`; links the forge writes to a comment (the feed's replies)
go through `commentAnchor()`, which counts comments the way the page cuts
them, and carry `?all=1` when the comment is folded away, so they always
land. A hand-typed `#c-…` into the folded part cannot be seen by the server
(the fragment never leaves the browser), so it needs `?all=1` too. The live
region still appends new comments at the bottom.

The terminal's issue and pull screens stay whole on purpose: they are a
scrolling text view of one thread already in memory, not a page a phone
downloads, so there is no weight to cut and no second key to learn.

## The front page

What a stranger is shown at `/`, ranked with its numbers, and a site admin's
say over it: pinned apps first (the first public pin is featured), hidden apps
never, a private app never. Every door reads `frontJson` in
`src/actions/front.ts` and sets through `setFront`, so they never disagree.

- **Web:** `/` for everyone; the admin's front-page settings pin, hide and weigh.
- **API:** `GET` and `PUT /api/v1/front`.
- **MCP:** `front_page` reads the list; a site admin passes `pinned`, `hidden`
  or `weights` (a dry run unless `dryRun: false`).
- **Terminal:** palette → "Front page" lists the same apps in the same order,
  each with forks, ships, use and fresh. For a site admin who is a person, `p`
  pins the selected app first (or unpins it) and `h` hides it (or shows it
  again, from the hidden rows at the end); each shows the plan, the dry run of
  `setFront`, and applies on Apply. Anyone else, signed out included, has the
  list and neither key.

## Who can see it

Every repository page says, beside the Private/Public badge, who can see it in
one sentence ("Private: only you and the crew."), and a writer's click goes to
Settings. `GET /api/v1/repos/:owner/:name` returns the same words as
`audience: { level, who, sentence }` (`who` is `owner`, `members` or
`anyone`), and so does a `PATCH` that changes its visibility, in the same
answer. The MCP `repo` and `here` tools carry it too (`here` on a repository
page, and on an app's link only for someone who may read the repository), and
the terminal's About card (`I`) shows the sentence (`docs/features/visibility-line.md`). It gives counts, never names; site
admins are not counted. All of them read `audienceFor` in `src/core/audience.ts`.

## Archive

An admin puts a repository away from **Settings → Archive**, with
`PATCH /api/v1/repos/:owner/:name {"archived":true|false}` (admins only; anyone
else gets 403), or in the terminal with `a` on the About card (`I`). The
repository page and the card then say when it was archived, and an admin gets
a Restore button or the same key to undo it. One tap from an app: an admin opens the app's page, presses Archive under
the page, and confirms on the page that follows (`POST /:owner/:name/archive`,
the same `updateRepoSettings` as the Settings form and the `archive` MCP tool).
Production and previews stop, the app leaves home and `/apps`, and its address
still answers. In the terminal the door is `a` on the About card. The archived list
(`/apps?archived=1`) has a Restore button on each row its viewer administers, and
returns to the list; the terminal restores from the About card with the same key
(`src/tui/screens/about.ts`). Archiving twice keeps the first date.
An archived repository starts no new crew run. Assigning an issue to an agent,
queueing a run again, asking the crew to propose a resolution, redirecting a
wave and converging a fork each answer "This repository is archived; restore it to
start a run."; the API answers 409 `archived`, and the terminal and MCP show
the same line. The autonomy tick skips it. A run already going finishes, and
Restore undoes all of it. Clone, push and links keep working, and the repository
page still answers.

An archived repository leaves the web home's apps, the inbox (work assigned to
you there included, and the terminal's and MCP's asks), the stalled-steps
reader and the explorer's default view; `/explore` shows it with `archived:yes`
(the **Show archived** toggle). It stays in `/apps`, search, the palette and
the repository API (`GET /api/v1/repos`).

`/apps` lists live (unarchived) apps only, with an "N archived" line linking to
`/apps?archived=1`, which lists just the archived ones (no All/Live filters, one
"Back to apps" link); each view reads its own window of 200 repositories. In
the SSH terminal the dashboard's *Yours* leaves archived repositories out too;
type in its filter (`/`) to reach them, as the filter searches every
repository you can see.

A site admin archives many at once from the home. In the **Your apps** card,
**Select** shows a checkbox per app (they take no room until then); tick some
and press **Archive**. This is the fleet's `archive` operation over those
repositories (`POST /home/archive`, same-origin, a site admin's), so it has the
fleet's receipt: the page that answers lists what was archived and an **Undo**
button for the person who ran it (kept for a day), after which the apps are back
on the home. The terminal's dashboard archives and undoes the same way (below), and so does the MCP `archive` tool given `repos` (at most 50; it answers the `operation` id, which `limb` with `action: "undo"` reverts for a day); each door refreshes an open web home (the `fleet.operated` event).

**Archive many, in the terminal:** on the home's repositories, an admin of a
repository marks it with `space`, `a` previews the marked ones by name and
archives them through the fleet `archive` verb (`applyFleetIds`), and `u` undoes
it (`undoFleetOp`). A non-admin has neither key.

`docs/FLEET.md` is one change across many repositories, runs or issues: a
query, a dry-run plan of every row before → after, a receipt, and undo.
`archive` (true or false) archives or restores many repositories; its undo is kept a day.

## Where it came from

A repository brought here with **Migrate** (`/migrate`) keeps where it came
from as links, never as a connection: the source's address, and — when its host
says it is a fork — what it forks (GitHub's `parent` and `source`, Forgejo's and
Gitea's `parent`; a pasted address's host is asked once, anonymously, after the
clone). The repository header then reads "Migrated from
github.com/Trevato/SO-ARM100 · fork of TheRobotStudio/SO-ARM100", each part a
link up. A fork made here of a migrated repository inherits its parent's
trail and reads "forked from … · migrated from … · fork of …" — at every door
below, for anyone who may read the parent; only the parent's admin can hide
that inherited part, and a fork's own record, if it has one, wins. The
terminal's About card (`I`) shows the same
as `migrated from` and `fork of` rows, `GET /api/v1/repos/:owner/:name` as
`provenance` `{ source, sourceUrl, parents: [{ fullName, url }], migratedAt }`,
and the MCP `repo` tool the same field.

An admin turns it off with **Settings → Show where this came from**,
`PATCH /api/v1/repos/:owner/:name {"showProvenance":false}`, `t` on the About
card, or the MCP `trail` tool (dry by default, admin scope). Off hides the line
on every page, in the terminal, and `provenance` is `null` in the API and MCP;
the record is kept, so on brings it back as it was. A source that was private
on its connected origin starts off, whatever it is migrated here as: its name
and owner on the other host are not published until an admin turns the line
on (a later re-record never overrides that choice). It is a person's call:
anyone else, an agent included, is refused (the API answers 404 before any
other field in the same request is saved). Repositories migrated from a pasted
address before this existed were filled in from their migration's `push`
event, without a fork chain; one picked from a connected origin then has none.

## Big directories

A directory page lists its first 300 entries, directories first; a "Show all N entries" row links to `?all=1`, and the footer says "Showing 300 of N entries". The side Files column keeps 100 rows per directory (its lazy `?fragment=explorer` too) with the same link. The terminal's file explorer is a scrolling, lazily loaded tree rather than a page, so it is unchanged. The limits are `TREE_WINDOW` and `COLUMN_WINDOW` in `src/web/pages/explorer.ts`.

**The terminal explorer lists every entry of a directory, on purpose.** The
web directory page and its side column are windowed because they send every row
as HTML; the workspace's explorer sends nothing. It holds one small node per
entry and draws only the rows that fit the screen (`drawTree`,
`src/tui/screens/workspace.ts`), so a directory of thousands costs a list in
memory, not a page. A window would hide files from a person who is searching
the tree with `t` or revealing a path, and it would need a "show the rest" key
for no saving. Revisit it if a directory's listing, not its drawing, is ever
measured slow.

## Search

`/search` answers repositories and issues in full, and greps code repository by repository. A first search starts no new `git grep` after 30 ms (`codeBudgetMs` in the forge config; a soft stop, since the grep in flight still finishes, one batch of four) and shows what it has with one link, **More code results** (`?code=all`), that greps the rest. `GET /api/v1/search` applies the same budget and reports the cut as `moreCode`; `code=all` lifts it. MCP `search` does the same, and its `all` argument lifts it. The terminal palette greps everything. A one-letter query greps no code at all (`MIN_CODE_QUERY`, 2 characters): it would match every line, so the page, the API's `note` and MCP say code is searched for 2 or more characters when code was asked for (`kind=all` or `code`), and repositories and issues still answer it. The terminal palette shares the rule — one letter greps nothing and takes no guest slot — but prints no note: its sections simply show no code.

The here-manifest (`GET /api/v1/here?path=…`) reads the same for guests and
members. On `/explore` and `/search` it names the page's own read, `?q=` carried
over and encoded: `GET /api/v1/explore?q=…` (MCP tool `explore`) or
`GET /api/v1/search?q=…` (MCP tool `search`), listed once.

## Share to the forge

Install the forge to your home screen, then Share a link or text to it from
any app: the home composer opens with it as a draft, and it is only sent when
you tap Post. Signed out, you sign in (or up) first and land on the same
draft. The share target is the web manifest's `share_target`, which only an
**installed PWA on Android and Chrome** offers; iOS Safari does not.

The home composer's app picker also has **the forge**: that sends no tell to
an app, it keeps what you typed as a thought, exactly as typed (works with no
apps too). Your thoughts from the last day stand at the top of the feed as
your own posts, marked "Received". The terminal has no feed or composer, so
thoughts are web-only there; `POST /api/v1/thoughts` is the other way in.
Within minutes the planner places each thought on the map and answers under it
in the feed, saying where it went; the MCP `thought` tool returns that
placement to the thought's author.
A thought that says an earlier one again does not open a duplicate: it links to
the earlier thought (`repeats`), comments on the issue it placed and raises it
to the front of the ready order, unless that issue is deferred or closed, which
the reply says. A close restatement counts only when the planner reads it as
plain work and nothing in it negates or flips the earlier one; "don't make X"
after "make X" is a reversal, never a repeat. A reversal links the thoughts it
takes back (`supersedes`). `/asked` shows "said again, first on …", "takes back
…" and "superseded by …" under each thought, and the MCP `thought` tool returns
`repeats`, `supersedes`, `repeatedBy` and `supersededBy` thought ids.

## Link-preview cards

`/og/repo/owner~name.svg`, `/og/app/slug.svg`, `/og/issue/owner~name~N.svg`,
`/og/pull/owner~name~N.svg` and `/og/run/owner~name~runid.svg` are 1200×630
social cards. They show only what an anonymous reader can open; anything
private, sealed or unknown is the same 404.

An app card carries the app's latest look (the production thumb, or a desktop
or phone shot taken as nobody) beside the words; a pull card carries the
production look as "before" and the pull's preview look as "after" (the
preview alone if production has none, nothing if the pull has no look). Only
a look an anonymous reader may fetch is used, of a public app and never a
sealed pull's. The picture is decoded, reduced to fit 480×300 and embedded as
a data URI (no dependency; the forge's own PNG codec), and the look's id and
taking name the card, so a new look is a new card. A look whose file cannot be
read leaves the card as it was.

Two of them carry a figure beside the words:

- **Map** — `/og/map/owner~name.svg`: the repository's dependency graph as a
  thumbnail, laid out exactly as `/owner/name/map` lays it out (ready green,
  working solid accent, blocked grey, waiting/held purple, parked amber,
  deferred and done faint), the critical path in the accent; beside it the
  open count, the critical path's length and ends, and the next issue a free
  hand would take; along the foot `ready · working · blocked · waiting · done`.
  Drawn from what a signed-out reader sees: no sealed issue, no run on one.
- **Audit** — `/og/audit.svg`: the policy score as a ring, the share of apps
  that hold (sound `contract.json` and no disagreeing probe; an app with no
  contract does not hold — 3 sound, one disobeying, one unread is 2 of 4,
  50%), with the top three findings worst first. Public repositories' apps only,
  as `/audit` shows them signed out.

The map page (public repositories) and `/audit` name their `.png` as
`og:image` with `twitter:card=summary_large_image`; every other page keeps the
forge icon.

### OG cards as PNG

`/og/{repo,app,issue,pull,run,map}/<ref>.png` and `/og/audit.png` are the same public cards as the `.svg`,
rasterized (1200×630) for the link previews that refuse SVG. Same refs, same
404s, same ETag-per-inputs (suffixed `-png`). Each PNG is rendered once and kept
under `$FORGE_APP_DATA/og-png/<sha256 of the inputs>.png`; the cache holds at
most 512 files (`OG_PNG_CAP` in `src/web/og/png-cache.ts`), least recently used
out first. Cold is about 120 ms, warm a file read. If the rasterizer will not
load or render, the route answers 503 with `retry-after: 30` and logs; nothing
else notices, since the rasterizer is only loaded on the first PNG request.

**Dependencies (one, vendored, not installed):** `package.json` `dependencies`
stays empty — the preview has no install step, so the files are committed under
`src/web/og/vendor/`, unmodified.

- *resvg* (`@resvg/resvg-wasm` 2.6.2, `resvg.mjs` + `resvg.wasm`): an SVG
  renderer compiled to WebAssembly, so no native binary or platform build. Why:
  rasterizing text and gradients correctly is not a 20-line file. 2.4 MB wasm +
  17 KB glue. Licence MPL-2.0.
- *DejaVu Sans, Sans Bold, Sans Mono, Sans Mono Bold* (2.37): the fonts the PNG
  is drawn in, so its text is the same on every host (the SVG names system
  fonts; the card clamps text with a deliberately wide estimate, which these
  fit). 2.0 MB. Free licence, `vendor/DEJAVU-LICENSE`.

Not done: the SVG route is unchanged and still the card's source of truth; the
rasterizer runs on the main thread (about 100 ms once per distinct card).

## Choosing among variants

A tell with `variants: n` starts n builders whose pulls share a variant group.
`/:owner/:name/variants/:group` is the deck: one card per open sibling with its
look and preview, linked from each sibling's change page. A writer likes or
dislikes each (plain form posts; on touch a mostly-horizontal swipe, with a
confirm before a dislike), through `POST /api/v1/repos/:owner/:name/pulls/:number/variant`
(`{"answer","reason"}`), the `variant` MCP tool, or `+`/`-` on a pull in the
terminal. Each person has one vote per pull, kept as a `lean` row in the
decision ledger. A dislike closes the pull and leaves its one-line reason as a
comment the builder reads; the last open sibling shows Ship. Readers see the
cards and no buttons.

While two or more siblings are open and none has shipped, a writer's feed holds
one **Choose** item for the group ("choose among N open variants of …") that
links to the deck, whatever the number of siblings; it is never muted away.
Once a sibling ships or all but one close, the item leaves the feed. The
terminal has no feed; the item is in `GET /api/v1/feed` and the MCP feed tool
as kind `choose`.
