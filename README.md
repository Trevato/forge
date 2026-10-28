# forge

A software forge you can read in an afternoon and mold by hand.

It runs the apps it hosts, and a **crew** of agents builds them. You describe
an app in a sentence; the sentence becomes an issue, and the agent it is
assigned to works it in its own fork and opens a pull. Every push redeploys
that pull's own preview — its own URL, on its own copy of production's data —
and every deploy is the check on that pull. No agent can move the default
branch, so the only way code reaches production is a merge a person made: the
crew proposes, you decide what ships.

That view is the **studio**, and it is the front door — a browser with no
`forge_mode` cookie lands there. It speaks four words for the whole loop:
_tell_, _working_, _look_ and _shipped_; an autonomous app lands its own
green changes, and nothing waits on a person. [`docs/STUDIO.md`](docs/STUDIO.md) is the tour;
[`docs/APPS.md`](docs/APPS.md) is the contract for apps, previews and runs. The
git underneath is one click away — the switch in the top bar, or `?mode=dev` on
any URL — and it is the rest of this page.

A forge this one spawned (hosted) runs the apps it was given too: its `bakery`
answers at `bakery--<child>--<this forge's host>`, in this forge's lanes, on the
child's own data, and `/forges` says how many are running and why any is not. Each row also ends with the first step its person has not taken (`not claimed yet`, `no everyday account yet`, `no tell yet`, or `going: last tell <time>`; `has not reported yet` before the child's first beat), read from the child's heartbeat; the terminal's forges screen and the MCP `forges` tool (`nextStep`) say the same.
`/forges` opens with the forges side by side (size, memory/CPU/disk against it or "shared", apps, last heartbeat; `docs/features/forges-side-by-side.md`). The list leads with the forges that need you, each badged
with why (also in the terminal and the MCP `forges`): "Not reporting" (no word
in 24 hours), "App down", or "Unclaimed" three days after it was sent; the rest
follow by last activity.
In the terminal an admin's palette offers "Forges you sent": each forge with its
claim state and the same apps-running note, never a claim link. Both carry the
crew's spend today against the daily ceiling that pauses it (`$3.20 of $10 today`), as the
child's heartbeat last reported it.

Each agent's scorecard — pulls landed of opened, review rounds, red checks,
reverts, time to land — is on Settings → Crew (`/settings/crew`) and in the
terminal's palette as "Crew scorecard per agent"; both are a forge admin's only.
The terminal's scorecard also ends each agent's row with `spend $ 5h · today · 7d`,
its cost over the last 5 hours, since 00:00 UTC and the last 7 days, as
`/settings/spend` reads it; `—` means nothing was spent in that span (`spend —`,
in all three).
Runs on P0, `opus`-labelled, planner and twice-bounced work use Opus (`docs/features/model-escalation.md`); the "Per model per day" spend and landed table is on Settings → Crew, in the terminal's "Crew scorecard" list, and in `GET /api/v1/crew/scorecard`.
Settings → Crew also shows, each only when it has something, a "Handed to the
planner" card (issues the crew parked twice: repo, issue link, when last
parked, why) and a "Restore drill" card (the last drill's pass or fail and
when). The terminal's palette has the same as "Crew hand-overs", a list of the
same rows (repo#number, title, reasons): Enter opens a parked row's issue and
`r` reads the list again. Both are a forge admin's only.

`/boards` carries a Held files card for anyone who administers a repository (a forge admin sees every repository's): the holds of the repositories you administer, a form to hold another path, Release on each row, and "Showing 200 of N" when the list is cut. The user menu links Boards to such a person. In the terminal, a bare line on the Held files prompt lists the same holds.

A hold can be set "until green" (a checkbox on the hold form, `until: "green"` on the hold API and the MCP `hold` tool): when a check passes on the pull's current head the forge releases it and the pull's timeline says `hold released: green on <short oid>`. A plain hold is never released by a check.

In the terminal, `h` on the pull screen asks for a one-line reason and holds the pull (an empty or over-200-character reason is refused in the prompt, as on the web and in MCP); on a held pull `h` asks to confirm and lets it go. Both go through `holdPull` and `releasePull`, so the header shows `held by <who>: <why>`. `h` is offered to a person who can write only: an agent or a reader does not get it.

A hold an agent placed does not stand forever: the tick releases one still standing after 24 h, in one transaction, with a comment on the pull, "Hold expired after 24 h: <why>. Back to @builder.", which shows in the pull's timeline like any comment, and the pull goes back to its builder (`expireCrewHolds` in `src/actions/holds.ts`). A person's hold is never expired. The window is fixed; a pull held again and expiring again leaves one such comment per round in its timeline.

In the terminal, `T` on a shipped pull's screen takes it back, as the pull page's button does: a one-line confirm names the pull, Yes opens the pull that undoes it (`revertPull`, `src/actions/revert.ts`) and shows it, No changes nothing. The key appears only to a person who can write a local repository (never an agent, a reader, a guest or a mirror), and refusals read as the page's do (`takeBackWords`). `T` also opens an app preview's terminal on an open pull; a shipped pull has no live preview, so the two never meet.

In the terminal, `m` on a local repository's issue list opens the plan screen (`src/tui/screens/plan.ts`): Working, Ready now, Waiting and Parked twice, each headed with its count. It reads what MCP `map` reads (`repoGraph` under the reader's sealed scope, `pillarView`, `mapHeldFor`, the runs in flight), so a sealed issue the reader may not see is left out. Enter opens the issue, `r` reads again, and the headings are skipped over. It is not offered on the pulls list or on a live browse of another forge.

A hand-over card on `/asks` (an agent's pull the reviewer stopped on after three rounds) has "Give back to the crew": one press assigns the pull, and the open issue it closes if a person holds it, to the agent that opened it, writes "Given back to the crew by @who", and the card leaves; the next tick starts its run. It is for a writer of the repository, and a pull a person opened, or by an agent gone from the crew, gets no button. In the terminal, `b` on a handed-over row of the On you pane does the same (`src/actions/give_back.ts`). The repository's planner can do it by comment: one that starts "Planner, one more round" on a handed-over crew pull emits the assignment to its builder, which starts the run (the pull is already the builder's, so nothing changes hands). It is the planner's alone; a reader's, the reviewer's or any other agent's does nothing. It is an agent's word, not a director's, so it does not end the hand-over: the card stays on `/asks` and the pull still counts as handed over during the round.

Home opens with "Since you were here · 2 days": the pulls that landed in public repositories since you last loaded `/` (1 hour to 7 days back, a day on a first visit); the terminal's home shows the same lines, and MCP `feed` answers them as `digest`. See `docs/features/since-you-were-here.md`.

In the terminal, the System screen (palette: System) shows a forge admin who is a person one more line, `telemetry:read held by: …` (the agents holding the grant), and `g` there picks an agent and asks `grant <agent> telemetry:read? y/n` (or `take back …`; the default is n). `y` calls `setTelemetryGrant`, as MCP `telemetry_grant` does; anyone that tool refuses sees neither the line nor the key hint, and `g` answers them in the tool's words.

In the terminal, the Capacity screen (palette: Capacity, a forge admin who is a person) lists every guard with its live value and bounds, as /settings/capacity does; `e` on one asks for a value (empty restores the default), shows `key: from → to` and calls `changeCapacity` only on `y` (default n). No row is read-only here.

An admin's home and the terminal's Flow dialog also say when the forge is clogged and how long the last clog took to notice and to clear: `docs/features/clog-watch.md`. A fork whose parent is archived shows one quiet line instead of its ahead/behind count, and its admin can detach it from the parent (Settings › Danger zone, the terminal's About `x`, MCP `detach`): `docs/features/detach.md`.

A pull the merge queue holds as red alone (red on its own merge at its current head; cleared by a new head or a moved main) says so under its checks line: "red alone at <time>, waiting for a new head or a new main", on the pull page, its live checks line and the studio change step, and in the checks row of the pull's terminal screen (`redMark` in `src/checks/queue.ts`). Nothing is drawn when it is not held.

On a sealed issue, a writer gets the private repository to fix it in: `POST /api/v1/repos/:owner/:name/issues/:number/private`, the issue page's button, and `p` on the issue's terminal screen, which shows the repository and its clone URL (built from the forge's origin). All three refuse alike: not found for anyone who may not see sealed reports, `not_sealed`, and `unverified`.

When an open issue waits for a blocker that closed as dropped or split, the terminal's issue screen pins a line under the title, "waits for #N (dropped), closed without being done". A writer who is a person (not a reader, not on the crew) sees `g` there: after a confirm (Cancel is the default) it calls `confirmIssue`, as the issue page and MCP `confirm_wait` do, and the line goes. With several blockers held, `g` first asks which one (or all of them).
An issue's title and body are edited on its page, with MCP `edit`, or with `e` on the issue's terminal screen: the editor opens with the title on the first line, a blank line, then the body; `ctrl+d` saves and `esc` discards. All three go through `editIssue`, so the same people may (the author until a writer takes it up, any person who writes the repository; never on a mirror) and a refusal reads the same, with the terminal's draft kept.

Reports from outside (sent with no account) are decided in the terminal too: open the repository as a person who writes it, press `:` and pick "Reports (N)"; beside each title is when it was sent, the page it came from and its words. `a` accepts the one under the cursor as an issue and says its number, `d` dismisses it after a confirm, and one someone else already decided says "this report was already decided". The row shows only while reports wait, and only to a person — not an agent — who can write the repository (`src/tui/screens/reports.ts`).

**Taking a shipped pull back**: `POST /api/v1/repos/:owner/:name/pulls/:number/take-back` (a person who can write here, `rw` token scope; a session needs a same-origin request) opens a new pull, `Revert "<title>"` from the branch `revert-<n>` into the default branch, that undoes exactly what the shipped pull merged. Nothing lands until a person merges it. It takes no body and answers 201 with the new pull, as `POST …/pulls` answers one. Refusals: an agent or a reader gets 403 `forbidden`; a read-only token gets 403; a pull that is unknown or that you may not see gets 404 `not_found`; 409 `not_shipped` (it never merged), 409 `already_reverted`, 409 `mirrored` (the origin owns the history); 409 `conflict` when the undo no longer applies cleanly, with the conflicting files in `message`, and nothing is left behind. A failure of the forge's own git is 500 `git_failed` with a fixed message; git's words go to the server log. The pull page's **Take back** is the same verb (`revertPull` in `src/actions/revert.ts`). The terminal's pull screen does not offer it yet.

The terminal's history says each commit's check, as MCP `commits` with `oid` does: a ✓ or ✗ mark on a log row where the commit's own check on the default branch passed or failed (blank where it has no verdict yet), and a `check:` line under one commit's title: `green`, `red · <first line of the failing step>`, `running`, `superseded` or `not run`, with `· via <sha>` when a later main commit's check answers for it. Nothing shows to a viewer who may not read the repository's runs (`src/checks/commit_check.ts`, `src/tui/screens/commits.ts`).

In the terminal workspace a `.csv` or `.tsv` file opens as a table (columns padded to their widest cell, the header kept on top, `N rows` in the status line; at most 1,000 rows and 64 columns are drawn and the rest is counted; a cell wider than 32 columns is cut with `…`, and the source view shows it whole). `s` flips between the table and the source, and a file that does not parse opens as source with `not a table: line N` in the status line (`src/text/csv.ts`, `src/tui/ui/grid.ts`).

Under the agents, each team that has a pull has one pooled row (its members'
counts added, the ratios taken from the sums; an agent on two teams counts in
both): `data-team` rows on the page, "team <name>" rows in that terminal screen.
Landed, review rounds and red checks stand as the last 30 days (pulls opened
since then) beside all time, so tuning an agent shows as movement; reverts and
time to land are all time. Under each agent, a sub-row per model and prompt
version its pulls ran on (the agent's latest run on the pull decides) carries
the same figures, so a change of model or brief shows against the one it
replaced; pulls opened before runs recorded either read "unrecorded", and are
counted, never dropped. The sub-rows list every pairing ever used; a pairing
unused in the last 30 days shows dashes there. The terminal shows them as
indented `↳` rows.

Scripts and agents read the same figures as JSON: `GET /api/v1/crew/scorecard`
and the MCP `scorecard` tool answer `{agents:[{username, all, recent, splits:[{model,
prompt, …figures, recent}]}]}`, where `all` is all time and `recent` the last 30
days. A ratio over nothing is `null`, and an agent with no pull has `all` and
`recent` null. Any token of a forge admin may read it (401 with none, 403 for
anyone else); the tool is listed for admins only.

A crew clone's dependencies are installed before the agent starts
(`installDependencies` in `src/crew/workdir.ts`), once per lockfile hash, so
the type check has its types. That install runs on the forge side, outside the
agent's shell sandbox, because the sandbox is built around the agent and the
install has to finish before it starts. It is bounded instead: a child env of
`PATH`, `HOME`, `TMPDIR` and the repository's install cache only (no `FORGE_*`
variable or key), `--ignore-scripts` so no package runs code, `--frozen-lockfile`,
and a 120 s kill. What remains is the registry and tarball fetch, which a
repository's `bunfig.toml` can point at a host of its choosing; that is the same
reach the agent's own `bun install` has through the sandbox's allowed hosts, and
a failed or killed install only logs and lets the run start.

Git hosting, code browsing, and a JSON API in one fast Bun process, with
**zero runtime dependencies** — the `package.json` dependency list is empty and
stays that way. The one exception is dev-only: `@anthropic-ai/sandbox-runtime`
(a devDependency, with its own few transitive packages) lets
`test/crew-sandbox-real.test.ts` run a shell under the very sandbox Claude Code
builds from the crew's settings; it never ships and the app never imports it. Everything worth having is written here: the Result type, the
router, the SSR templates, the design system, the markdown renderer. The only
thing forge asks of the host is a `git` binary.

Forgejo is the reference for what a forge should _feel_ like. This is that
feeling on a foundation sized for one person.

## Run it

```sh
bun install          # dev-only: types + tsc (native, 7.x), no runtime deps
bun run src/main.ts  # web on :3000, ssh on :2222 (FORGE_SSH_PORT=0 turns it off; a taken port turns it off with one warning)
bun src/main.ts --preflight  # can this tree boot? config parses, migrations run on a copy of the database; one line, exit 0 or 1, no socket opened. Run it before the swap, not under load: the copy is not atomic against a live writer, and a `preflight-*` directory a killed run left behind is swept by the next run once an hour old, and a missing data directory is created, as boot would
bun src/main.ts --rollback <sha>  # swap back to a kept release: a full 40-hex sha under $FORGE_DATA/releases/, PORT as the running forge's. Exit 0 once that release reads healthy as that sha, else 1 with one line
bun src/main.ts --first-admin  # a forge with no admin: print a one-time code that makes one (below)
```

Apps and agent runs are contained only where `bwrap` (bubblewrap) and `socat`
are on `PATH` (Linux); without them they run uncontained, and the boot log says
so. The crew also needs the `claude` CLI and a model credential.

The container image pins Bun to an exact patch release in `Dockerfile` (`test/dockerfile-pin.test.ts` refuses a floating tag). To move it, change that one `FROM` line, run the check, and watch the first hour of `/system`.

Set `FORGE_REPO=owner/name` to the forge's own code and a pull the crew lands there is written to `$FORGE_DATA/releases/<sha>/` (the newest `FORGE_RELEASES_KEEP`, default 5, are kept), preflighted with that tree's own `--preflight`, and recorded in the `release` table (sha, landed pull, verdict, its line, when). A red preflight is asked again once (the copy of the live database can tear under load); a second red is logged and told to the landed pull. Other repositories are untouched, and nothing is swapped unless `FORGE_SELF_SWAP=1`: then the forge binds its port with SO_REUSEPORT, a green release is started from `releases/<sha>/` beside it on the same port (`FORGE_COMMIT` set to the sha), `/api/v1/health` is read until an answer names that sha and is well (`FORGE_SWAP_BUDGET_S`, default 60), and only then does this process drain as a SIGTERM does — except that it stops accepting at once, so every new connection is the release's, and answers what it already holds (a long push or clone) to the end, for up to five minutes, before it closes. A release not healthy in its budget is killed, the old keeps serving, and the log and the landed pull say so. One swap per process: a landing while another swap is in its budget, or after one succeeded, is released and recorded but not started (the new process runs it from the next restart). The SSH terminal is not handed over yet (the new process cannot bind the old one's port), so a process holding the SSH listener refuses the swap and tells the landed pull; run with `FORGE_SSH_PORT=0` to swap. The swap also needs `net.ipv4.tcp_migrate_req=1` (Linux 5.14+): without it the kernel resets the connections still queued on the old listener when it closes, so a swap is refused (and told to the landed pull) rather than failing requests. The release is a child of the old process, so the swap is for a forge run directly, not under a supervisor that kills its children when the old process exits (PID 1 of a container, a systemd unit with the default `KillMode=control-group`). SO_REUSEPORT lets any process of the forge's user bind the same port and take a share of its connections, so `FORGE_SELF_SWAP=1` assumes nothing else runs as the forge's user on the host network (agents and apps are sandboxed or in cells). `--rollback <sha>` starts the kept release beside the running forge by the same health-read swap (`FORGE_SWAP_BUDGET_S` does not apply: it waits the default 60s), and a release that is not healthy is killed with the old still serving. It refuses, with one line and exit 1, a sha that is not kept (never checked out, or pruned) and a release whose schema has fewer migrations than the live database has applied (`<sha> predates schema N; rolling back would need a down-migration`); a release with a newer schema is allowed, as it migrates forward on boot, and the database's refusal of a future schema is unchanged. It does not drain the forge that was serving: until part 2 of the rollback does, both processes share the port and the operator stops the old one (the command prints that). It does not check `tcp_migrate_req` or SSH either; stopping the old process cleanly needs the same `net.ipv4.tcp_migrate_req=1` setup as the swap, and the SSH port stays with the old process. `/releases` lists the kept releases (short sha, landed pull, when, and since when the live one has been healthy: this process's start); a person who writes the `FORGE_REPO` repository (never an agent: the button is hidden and the POST is a 403) gets a Roll back button on a kept, schema-compatible release, which runs the same refusals and swap and then drains this process (so it needs `FORGE_SELF_SWAP=1`); only readers of that repository and site admins see the page and the home line (anyone else gets a 404), and the forge's SSH terminal has the same, gated the same (`src/release/gate.ts`): the palette's `Releases` shows `live: <sha> since <time>` and the kept releases, only to those readers, and Enter on a rollable release asks to confirm then runs the same rollback as the button (a person who writes the repository only, never an agent; told when `FORGE_SELF_SWAP` is off); the home carries a `live: <sha> since <time>` line linking there. A script reaches the same rollback at `POST /api/v1/admin/releases/<sha>/rollback` with an admin-scope token: it plans by default (`{from?, to, allowed, message?}`, nothing moves), `{"dryRun": false}` applies it, and the same people and rules apply as on the page (never an agent). `FORGE_REPO` also names the parent code that spawned child forges fork.

**Keeping a domain drill**: `POST /api/v1/drills` (a site admin person; an agent is refused with 403, and a session needs a same-origin request) takes `{domain, seen:{health, board}, backSeconds}`: a domain key from `docs/DOMAINS.md`, what the drill read from health and the board (text, at most 8000 characters each), and whole seconds until the forge was well again (0 to 31536000). The body is capped at 32000 bytes (413). It answers 201 `{id, domain, backSeconds, green, why}`: the verdict is judged against the domain's own words and kept whether green or red. An unknown domain, bad `seen` or bad `backSeconds` is 422. Kept drills are read back on **Settings → Backups**, in its **Failure domains** card (`docs/SNAPSHOT.md`). To run a drill by hand, `FORGE_TOKEN=… bun scripts/drills/run.ts <domain> --forge <url>` (plain `http` is refused unless the host is loopback or you pass `--insecure`) prompts for the fault, watches health and the board until the forge is back, and posts this for you (`docs/DOMAINS.md`).

**Re-checking a shared red**: `POST /api/v1/repos/:owner/:name/checks/recheck` (a repository admin, `admin` token scope; anyone else gets 404, and a session needs a same-origin request) takes `{test}`: the name of one failing test exactly as the check log's failing names show it, 1 to 300 characters (otherwise 400). It asks again, through the ordinary check queue, for every open pull whose latest check on its current head failed on that test, and answers `{queued: [pull numbers]}`. At most 50 pulls are queued per call; when more were red, the answer adds `more` (how many were left) and a `message`, and a second call takes the rest. A pull waiting for a writer's approval, or whose head declares no check, is not in `queued`.

If your shell already has `FORGE_URL` set — a crew workspace sets it to the
forge you work for — this forge takes it as its own canonical address and
refuses every form a browser posts to `localhost`: run it with
`env -u FORGE_URL bun run src/main.ts`, or set `FORGE_URL` to wherever you
will actually browse it.

Who may sign up (open, invite or closed) is shown on the terminal's Invite
links screen, and a forge admin who is a person changes it there with `s`,
which shows from → to and changes it only after a confirm (as MCP `signup` does).

No sign-up makes the admin, not even the forge's first, and that first one is
held to the signup setting and Turnstile like any other. Accounts sign up with
a passkey and an email address (there is no password signup), and the browser
at `/signup`, the API and the terminal all make an account that is not an
admin. The site admin is made from the operator's terminal with
`--first-admin`, which needs no browser at all and works whatever signup says,
or, on a spawned child, by its `/claim` link (code that sets a forge up
directly, like test fixtures, seeds one):

```sh
# One-time code, printed only here: works once, for 15 minutes, and never once
# anyone is admin. --child <name> mints for a child this forge hosts; --url
# names the address to print. The forge keeps only its hash. Run it beside
# the running forge with the same FORGE_DATA (and PORT, or --url, for the
# link); before the forge's first boot there is no database and it refuses.
bun src/main.ts --first-admin

# A person opens the printed link and makes the admin with a passkey.
# A headless agent trades the part after "#" for a token instead:
TOKEN=$(curl -sX POST localhost:3000/api/v1/first-admin \
  -d '{"code":"<code>","username":"you","email":"you@forge.dev","scope":"rw"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

curl -sX POST localhost:3000/api/v1/repos -H "authorization: Bearer $TOKEN" \
  -d '{"name":"hello","visibility":"public"}'

git clone "http://you:$TOKEN@localhost:3000/you/hello.git"
```

`POST /api/v1/first-admin` takes `{code, username, email, scope, name?,
expiresIn?}` (`scope` is `ro`, `rw` or `admin`; `name` names the token) and
answers 201 once with `{user, scope, id, token, expiresAt, expiresIn}`. The
token always expires: in a day (86400 seconds) unless `expiresIn` asks for
whole seconds from 60 to 2592000 (30 days); anything else is 422
`invalid_expiry` and spends nothing. The account has no password or passkey and
a token cannot mint tokens, so once its token lapses it cannot sign in.

If that leaves no admin with a working credential (no password, passkey,
unexpired token, live session, SSH key or sign-in with the parent), running
`--first-admin` again prints a recovery code for the stranded admin instead
(`--user <name>` picks one when there are several). It has the same rules: it
works once, for 15 minutes, only its hash is kept, and it is rate-limited. Send
it to `POST /api/v1/first-admin/recover` with `{code, scope, name?, expiresIn?}`
and you get back a new expiring token for that existing admin, in the same
shape as above. No account is made, and each kind of code is refused at the
other's door. The command refuses, and a live code dies, as long as any admin
can still sign in. The audit records it as `user.recovered` with
`via: first-admin-recovery`. Every refusal of the code (wrong, used, expired,
replaced, or the forge already has an admin) is the same 403. Every attempt, at
either door, is counted before the code is read, per address and for the whole
forge, at the sign-in limits (429 past them). The account made is in the audit
as `user.created` `via: first-admin`, and the sign-in page links `/first-admin`
only while the forge has no admin. Later tokens come from Settings → Tokens, or
`POST /api/v1/tokens` from a signed-in session with `{"name", "scope"}`; the
admin adds `"adminConfirm": true` to mean a token that acts as admin. `ro` and
`rw` are open to anyone; a member asking for `admin` gets 403 ("Only an admin
can make a token with admin scope; ro and rw are open to you."), and the
Settings form offers `admin` only to an admin.

The same token spawns a child forge (`dryRun` is true unless `false`, so
without it you get the plan and nothing is made). The child's admin comes
from the operator's `--first-admin --child`, or from the `claimUrl` the spawn
answers once:

```sh
curl -sX POST localhost:3000/api/v1/forges -H "authorization: Bearer $TOKEN" \
  -d '{"name":"kid","dryRun":false}'
# {…, "url":"http://kid--localhost:3000", "claimUrl":"http://kid--localhost:3000/claim#…"}
bun src/main.ts --first-admin --child kid
```

The child keeps this forge's scheme and port at `<name>--<host>`, on its own
data under `$FORGE_DATA/children/`. Browsers send `*.localhost` to this
machine; curl needs `--resolve kid--localhost:3000:127.0.0.1`. The rest is in
`docs/SPAWN.md`.

The commits the forge writes for you — merges, squashes, reverts, web edits —
carry `you@users.noreply.<forge host>`, never your account email. Choosing your
real address is an opt-in under **Commit email** in `/settings` (or
`PATCH /api/v1/user` with `{"commitEmail":"account"}`); commits you push
yourself carry whatever your own git says.

### Attaching the Claude app or Grok (OAuth)

Add a custom connector with the URL `https://<your forge>/mcp`. The client
registers itself at `/oauth/register` (the Claude app's callback is
`https://claude.ai/api/mcp/auth_callback`), sends you to `/oauth/authorize`
to sign in and choose `ro` or `rw` and a token name, then exchanges a
single-use 60-second code with its PKCE S256 verifier at `/oauth/token` for
the same token Settings mints; revoke it there. Details in `docs/MCP.md`.

### Proposal tokens

A writer of a repository can hand a child (a fork, or a project on another
forge) a credential that reads this repository's code (so the child's forge can
fork it), proposes, and nothing more:

```sh
curl -sX POST localhost:3000/api/v1/repos/you/hello/proposal-tokens \
  -H "authorization: Bearer $TOKEN" \
  -d '{"child":"kid","origin":"https://kid.example.com/","childRepo":"kid/hello"}'
```

`child` is lowercase words and hyphens; `origin` an https address;
`childRepo` (optional) a fork of this repository, and deleting it deletes the
token, as does deleting the repository. The token expires in 30 days. It is
listed as `proposal:<child>` among your tokens, and revoking it there ends it.
Over HTTPS it clones and fetches this one repository (private or not; no other
repository, secret, app or issue; a fetch sees every branch, other children's
`child/*` included), pushes only `child/<name>/…` branches of this repository (anything
else is refused with one line) and `POST …/pulls` from one of them, with a
body of at most 64 KiB and 20 requests a minute. Every other request is a
403, decided in `src/http/proposal_gate.ts` before any handler runs. A proposed pull
runs no check and no preview until a writer approves its head or lets it run
(**Let it run here**, which is not a review; a new push waits again), and a bare push to `child/…` starts none. A pull
opened with it says "proposed by child … from …" on every tab of the pull's
page, in the terminal's pull view, and as `proposal` in the pull's JSON
(`GET …/pulls/:number`, and MCP's `pull` tool). `GET …/pulls/:number?diff=0` reads the pull without its diff (and skips computing it); `diff` is `0` or `1`, default `1`, and anything else answers 422. `GET …/issues?fields=brief` lists issues with only number, kind, title, state, labels, assignee, author, originAuthor, authorIsAgent, createdAt and updatedAt (and `untrusted` where it applies); no bodies or comments. `fields` is `brief` or left out, and anything else answers 422 `invalid_fields`. `GET …/repos/:owner/:name/events` answers `{ items, next_cursor }`, newest first, `limit` 1 to 200 (default 50) and `cursor` from `next_cursor` (anything else is a 422); it used to answer a bare array of every event, so a client that read the array reads `items` now. A request reads at most 1,000 events, so when most of them are hidden from the reader a page can come back short with a `next_cursor`: keep following it until it is null. MCP's `events` tool answers the same. `GET …/repos/:owner/:name/branches` answers `{ items, next_cursor }` in the order it always had, `limit` 1 to 200 (default 50) and `cursor` the `next_cursor` of the page before (the name of the last branch on it); anything else is a 422, and a cursor naming a branch deleted between two requests is `invalid_cursor`, so start over. It used to answer a bare array, so a client that read the array reads `items` now. `GET …/repos/:owner/:name/forks`, `…/labels` and `…/hooks` answer `{ items, next_cursor }` too, in the order they always had, `limit` 1 to 200 (default 50) and `cursor` the `next_cursor` of the page before (the id of the last row on it); anything else is a 422, and a cursor naming a row deleted between two requests is `invalid_cursor`, so start over. They used to answer a bare array, so a client that read the array reads `items` now.

### Proposing to a parent forge

A spawned forge can offer its change to its parent with a proposal token, and an admin sets how it follows the parent. Details, API, MCP and terminal doors: [`docs/FOLLOWING.md`](docs/FOLLOWING.md#proposing-to-a-parent-forge).

The terminal's launcher search (`/`) is the explorer when the line has a
`kind:` or `sort:` word: `kind:app sort:forks garden` ranks as `/explore`
does, by the same action, with each row's forks, merges, hours in use and
freshness, and a "Read as:" line says how the line was understood. Enter on an
app opens it; a person or forge row has no terminal page and says where the
web has it. A plain line still matches your repositories by name.

## On your machine

The forge holds the truth; `forge` keeps a copy of the parts you work on, the
way a music player keeps the albums you listen to — downloaded, fresh, and
yours when the network is not.

```sh
forge login forge.example.com    # a URL and a token, stored 0600 (macOS: keychain)
forge sync                       # clone what is missing, fetch the rest, report
forge status                     # the same report, without touching the network
forge                            # the local UI over your clones
```

A bare host means https; `localhost`, `127.0.0.1` and `[::1]` mean http. Plain
`http://` to any other machine is refused — the token would cross the network in
clear — unless you log in with `--insecure` for a host you trust; that is kept
with that workbench only, and `FORGE_URL` to another such address is refused too.

Repos land under `~/src/<host>/<owner>/<name>` — the path is the identity, so
two forges with a `docs` repo never collide, and the filesystem is the index
(there is no local database of "your repos"; the walk finds them). `--root`
or `FORGE_ROOT` moves the library; `FORGE_URL` and `FORGE_TOKEN` override the
stored config for a script or a CI job.

```sh
forge sync --watch --interval 5m   # notify only when something CHANGED
forge sync --ff                    # fast-forward clean repos, and only those
forge pin owner/name               # ask the workbench to keep this one here
forge ls                           # what is here, and how stale
forge open owner/name --web        # the page, in a browser
forge ship 12                      # land pull #12 after a y/N, as Merge does
forge pulls                        # open pulls of this clone, newest first
forge asks                         # what waits on you, most important first
forge asks --repo owner/name       # only that repository's; --json for the API's answer
forge asks --ship 1 3              # decide by the line numbers just printed: planned, then Apply? [y/N]
forge asks --close 2 --reason "words"   # also --dismiss 4; --yes skips the question (needed without a TTY)
forge asks --undo <id>             # take back a decision by the receipt id it printed
```

`forge ship <number>` reads the repository from `--repo owner/name` or from
the folder's `origin` when it points at your workbench, shows the pull's
title, check and whether it merges, and asks `Ship #12? [y/N]`. `--yes` skips
the question; with no terminal and no `--yes` it refuses (exit 2). The
merge's rules stay the forge's: a refusal prints the forge's words and exits
5 (3 for a refused token), and is never retried.

`forge pulls` prints one line per pull: `#N`, the title cut to the terminal
width, the author, the check (`green`, `red`, `running` or `none`) and the
preview address when the repository is an app. It asks about the repository
your `origin` remote names, when that remote is on the configured workbench;
anywhere else it exits 2 and says so, and `--repo owner/name` names one
yourself. `--closed` lists closed pulls, `--json` prints the API's answer, and
a list longer than the 100-pull pages it follows is marked as cut. This is a
shell command on purpose: the terminal UI of the forge (`ssh`, `src/tty.ts`)
already has its own pulls screen, and the local UI is about working trees, not
the workbench's conversation; the pulls API and MCP are the other doors.

`sync` never merges, rebases, resets or checks anything out. `--ff` is the one
exception and it fast-forwards a repo only when the tree is clean, nothing is
ahead, no rebase or merge is half-finished, and `merge-base --is-ancestor` has
proved that moving the branch cannot lose a commit. A dirty repo is reported
and left exactly as you left it.

`sync` hands git your token only for a remote on the workbench's own origin
(scheme, host and port) over https, or plain http to loopback. A clone whose
`origin` was edited to anywhere else is fetched without the token, and its row
says `no token sent`.

`forge` with no arguments opens the local UI on the same runtime as the SSH
one: the library of clones, then a lazygit-shaped working-tree screen —
`space` stages, `enter` opens the hunks, `s` stages one, `c` commits, `P`
pushes, `b` branches, `l` log, `z` stashes, `?` shows every binding.

In the SSH terminal, `enter` on a run opens its log (the last 200 lines, following new ones while it runs; "Not found" where the web would say so), and `o` there prints the web address (`src/tui/screens/runlog.ts`).

Build it once and put it on your PATH:

```sh
bun build --compile src/cli/main.ts --outfile dist/forge
```

That produces a self-contained binary (it embeds the Bun runtime, so expect
something in the 60–110 MB range; `dist/` is gitignored and binaries are never
committed). Until you build it, `bun run src/cli/main.ts …` is the same
program.

## Develop

Tests, checks, the gate, lint, types and how a change reaches main: **[docs/DEVELOP.md](docs/DEVELOP.md)**.

## Shape

```
src/
  main.ts     boot
  app.ts      composition root (one data dir = one forge)
  kernel/     zero-dep primitives: result, error, id, log, db, hash
  git/        bare repos, smart HTTP v2, cat-file readers, hooks, guards
  core/       domain: users, sessions, tokens, repos, events, schema
  actions/    every mutation once: authorize, mutate, record the event
  http/       router, request context, the server
  design/     the theme registry both surfaces render
  web/        SSR: html tag, design tokens, markdown, pages
  ssh/        a zero-dependency SSH server: transport, userauth, channels
  tui/        the terminal UI: runtime, widgets, screens, the ssh front door,
              and local/ — the same runtime over your own working trees
  cli/        `forge` on your machine: login, sync, status, pins
  apps/       a repository that runs: manifest, checkout, process, data,
              the runtime (environments), the proxy by Host
  runs/       run logs, appended live
  crew/       agents as child processes: the brief, Claude Code headless,
              the runner, dispatch off the outbox
```

Read `docs/ARCHITECTURE.md` for the principles and the reasoning behind them.
Contributing (human or agent) starts at `CLAUDE.md` — the invariants and how to
work here.

## What works today

Open an image or SVG in a repository and it is drawn, fit to the pane. Press
**Actual size** (or click the picture) for 100%; the pane scrolls or drags to
pan. The header shows its pixel size, file size and format; **Source**,
**Raw** and **Download** stay beside it. The terminal's file view draws a
binary picture where the terminal can, and otherwise names the file and its
size; SVG there shows as its source text.

The running list of what the forge does, one bullet each, lives in
[`docs/STATUS.md`](docs/STATUS.md).

A milestone says how fast it is moving in one line — `on pace for <date>`,
`no movement in 7 days` or `done <date>` — with issues closed per day over 14
days drawn beside it, on its page, in the terminal's Milestones screen and in
the MCP's `milestones` tool (`closedPerDay`, `paceDate`); `docs/PLANNING.md`
has the rule.

## Where the rest is

- [`docs/DEVELOP.md`](docs/DEVELOP.md) — developing the forge: tests, checks, the gate, lint and types.
- [`docs/STATUS.md`](docs/STATUS.md) — what works today, one bullet per feature.
This page is the front door. Everything else is a file of its own under
`docs/`, each about one thing:

**Using it**

- [`docs/VISION.md`](docs/VISION.md) — what the forge is for, and the order of work.
- [`docs/STUDIO.md`](docs/STUDIO.md) — the front door in full: the five words and where each is decided, the box, the three lists, a tell, a run and a change each on its own page, and the board.
- [`docs/TOUR.md`](docs/TOUR.md) — every other page and screen, with each of its doors: the terminal over SSH, the home and its figures, review, signing in, the page-view beacon, the board's notes, long threads, who can see a repository, archive, where a repository came from, big directories, search, sharing to the forge, link-preview cards and choosing among variants.
- [`docs/ASKS.md`](docs/ASKS.md) — what waits on you and how to answer it: waiting pulls, mutes, wave proposals, feed chips and the decider.
- [`docs/FEED.md`](docs/FEED.md) — the feed: what happened, ranked, each item with why it is there. The home composer keeps your draft across a reload.
- [`docs/PULLS.md`](docs/PULLS.md) — resolving a conflicted pull without a clone.
- [`docs/GIT.md`](docs/GIT.md) — cloning over HTTPS and SSH, and partial clones of big repositories.
- [`docs/CLI.md`](docs/CLI.md) — the `forge` command on your machine: install, log in, and every command with its flags and one example.
- [`docs/features/csv-view.md`](docs/features/csv-view.md) — open a `.csv` or `.tsv` in the code view to read it as a table; `?all=1` draws more rows, `?view=source` shows the text. The terminal has its own table view for them (see the `.csv` paragraph above).
- [`docs/features/file-media.md`](docs/features/file-media.md) — a file in the browser: every file page has **Raw** and **Download** (any size), and `/:owner/:name/media/:ref/*path` serves images, audio, video and PDFs under their real type, sandboxed, with byte ranges.
- [`docs/features/config-form.md`](docs/features/config-form.md) — a JSON file opens as a form: typed fields (from its schema when one is found), cards to add and reorder, and a save that commits for a writer or proposes a pull for anyone else. In the terminal, a reader edits in the workspace (`e`) and `c` proposes the change from their fork; any commit there that breaks a JSON file's schema is refused first.
- [`docs/ROLES.md`](docs/ROLES.md) — guest, member and admin, and what each may do.
- [`docs/MCP.md`](docs/MCP.md) — the forge as a connector; [`docs/STANDARDS.md`](docs/STANDARDS.md) is what it answers by default: `.well-known`, feeds, cards, the manifest.

**Apps and the crew**

- [`docs/APPS.md`](docs/APPS.md) — the contract for apps, previews and runs: making an app, the vocabulary, and the rules that are mechanical rather than advisory.
- [`docs/CONTRACT.md`](docs/CONTRACT.md) — who may do what, as a table: an app's `contract.json`, the one evaluator every app decides with, the audit that reads it from git, the probe that knocks on the running app, and the wall a person alone crosses.
- [`docs/WEBSPEC-PREVIEWS.md`](docs/WEBSPEC-PREVIEWS.md) — the website specification run over every preview, report-only.
- [`docs/CREW.md`](docs/CREW.md) — the crew: agents, how a run works, review, live triage, the merge queue, spend, roles and invites, the sandbox, passports, and the direction a vision pull will write.
- [`docs/SENTINEL.md`](docs/SENTINEL.md) — the forge hunting its own faults; [`docs/HUNT.md`](docs/HUNT.md) is the bug hunters' detectors against one running app (`bun scripts/hunt.ts <origin>`).
- Flow only: a repository's admin (a person, never an agent) sets one switch from Settings → On its own, `PATCH /api/v1/repos/:owner/:name` with `flowOnly`, MCP `repo_settings`, or `w` on the terminal's About card (`I`); turning it on makes the `flow` label. While it is on, the repository header and its admin's home say so in one line (the line links to the setting for an admin only; on the home it appears under "Show everything", not the lean apps-first view). While it is on, builders start only `flow` issues; assigning any other issue is recorded but starts no run and reads "queued: flow only" (web, terminal, API and MCP `issue`) until it gets the `flow` label or the switch goes off, and then it dispatches. Rebase, re-check, red-fix and review runs always go. On the forge's own repository, while it is off, each admin's home carries one **Flow only** button after the flow alarms (it posts to the setting's route and lands on the setting, where it turns off again); and once it is on and no flow alarm has stood for 24 h (the alarms the home shows, with the same crew ceiling) the minute's tick turns it off, once, with one feed item for admins; the terminal's About row reads "on, off after 24 h clear". The auto-off applies to the forge's own repository only (`src/flow/flow_only_auto.ts`).
- Outsiders directing the crew: the terminal's About card (`I`) has a Crew row saying whether people who cannot write may direct the crew (the web page's words). A repository admin who is a person presses `d` to see the plan, then enter to confirm (esc changes nothing); it calls `setCrewOutsiders`, as MCP `outsiders` does. The key is `d`, not `o`, because `o` is the fork's upstream offer on the same card and `d` never clashes with it; a writer who is not an admin and an agent are not offered `d`.
- Prompt source at the terminal: `i` on the Deploys screen opens the app's Instagram prompt source, as Settings › Prompts does, and is offered only to the repository's admin who is a person (an agent, a reader or a guest sees no `i` and it does nothing). It lists the account, when it last ran and what it said, and when the token is refreshed again. `a` connects one (the token typed masked, then the hour in UTC; it is never drawn or logged), `f` fetches now and says what came back, `d` removes it after a `y/n` confirm. A second `f` while a fetch is running is ignored. Refusals are the page's words (`invalid_token`, `invalid_at`, `no_such_source`, `not_running`, and `already_connected` only when an account was connected on the web while the screen was open: the screen offers `a` only when there is none).
- Events at the terminal: `v` on the About card (`I`) lists the repository's events newest first, 50 at a time; `n` loads the next page, `esc` goes back; it reads once on opening and does not refresh while open. The audience is `GET …/events`'s and MCP `events`' (a webhook's URL and an app's variable names are the admins').
- [`docs/FLOW.md`](docs/FLOW.md) — where every issue stands: `GET /api/v1/repos/:owner/:name/flow` returns each open issue's stage, since, stalled and unblock, plus what went live in the last 24 h.
- Flow reads: `bun scripts/flow-report.ts [--db <path>] [--public] [--json]` prints one line per read; see [`docs/FLOW.md`](docs/FLOW.md).
- Under it, the panel says the crew's build yield over 24 h (runs finished, pushed, landed; `src/flow/build_yield.ts`) and the median hours to first review (`src/flow/review_latency.ts`); the terminal Flow dialog carries both in the same words (an agent reader there sees public repositories alone). `/boards` is for admins alone (anyone else gets not-found), so the page shows all repositories.
- The flow panel on `/boards` also says the time to land (median and slowest of the last 24 h, `src/flow/lead_time.ts`) and who opened the last hour's pulls (names linked, `src/flow/openers.ts`); non-admins read public repositories alone. The terminal Flow dialog carries the same two facts in its own words.
- The flow panel's Hot files card and the terminal Flow dialog also name files that gained open pulls over the last hour ("warming: src/a.ts 2 → 4 pulls", at most 5; `src/flow/hot_trend.ts`). The hour-old counts are samples kept in memory by `src/crew/hot_history.ts`, so after a restart nothing is named until a half-hour-old sample exists; an agent sees public repositories only. The MCP `flow` tool does not carry it yet.
- Under each queued repository's merge-queue line, the terminal Flow dialog lists its last five gates, newest first: the pulls carried, `green`, `red` or `cut off`, how long ago, and for a red gate the first failing test with its file, `flaky` when two gates sharing no pull failed it (`src/checks/gate_result.ts`, as MCP `queue_gates` reads them); a repository with none kept says `no gates yet`, and an agent reader sees public repositories only.
- The flow panel on `/boards` has a Last gates card: the newest ten merge-queue gates, each with its pulls linked, green, red or cut off, and the first failing test with its first error line (or the reason a gate was cut off). A gate carrying a sealed pull shows `a sealed pull` and the verdict alone; a non-admin reader sees public repositories only (`src/web/pages/boards-gates.ts`, the same `recentGates` read as MCP `queue_gates`).
- The flow panel on `/boards` and the terminal Flow dialog say how the open crew pulls sort into piles (red, conflicted, changes asked, approved and waiting, awaiting review), each pull counted once in the first pile it fits (`src/flow/pile.ts`).
- The off-box snapshot mirror is set from three doors with one set of rules (`src/actions/mirror.ts`): Settings → Backups, MCP `mirror_set` (`set` or `forget`), and the terminal's Resilience screen (a forge admin who is a person; an admin agent only reads). The screen shows `Mirror: <place>` or `Mirror: none.`, `m` seals it with five prompts (endpoint, bucket, region, access key, secret key; the keys are masked as typed) where a blank keeps what was sealed, and `f` forgets it after a confirm. `t` tests where snapshots go, as MCP `backups_test` and the Backups page's Test button do: the sealed destination, otherwise the environment's, said as `Reached …: N objects listed.` or `Could not list …: <reason>` in the page's words; with none set it says so and calls nobody. A key is never read back or drawn.
- [`docs/PLANNING.md`](docs/PLANNING.md) — how issues depend on issues: the edge, the map, and what "ready now" means to a person and to the crew.
- [`docs/FLEET.md`](docs/FLEET.md) — one change across many repositories, runs or issues: a query, a dry-run plan of every row before → after, a receipt, and undo.
- [`docs/HOME-EVAL.md`](docs/HOME-EVAL.md) — scoring the owner's home with a reader who has no context.
- [`docs/PROFIT.md`](docs/PROFIT.md) — the profit slider: cost against responsiveness.

**Other forges, and the forges this one spawns**

- [`docs/ORIGINS.md`](docs/ORIGINS.md) — one workbench over GitHub, Forgejo and Gitea: connecting, mirroring, writing through, migrating, and following an outside branch.
- [`docs/SPAWN.md`](docs/SPAWN.md) — a forge births a forge: the claim link, the family, sizes and the child quota.
- [`docs/FOLLOWING.md`](docs/FOLLOWING.md) — a fork that keeps up with its parent: where it stands, taking updates, the crew's part when both sides moved, and ranked forks.

**Running it**

- [`docs/OPERATING.md`](docs/OPERATING.md) — configuration, health, how a release proves itself, flags, limits, check tiers, fuzz and chaos, and writing a database guard.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the principles and the reasoning behind the shape above.
- [`docs/CACHING.md`](docs/CACHING.md) — what the forge keeps between requests to make `/map` and `/` fast: each map lane's plan and each viewer's feed candidates, stamped with SQLite's own write clock so any write is seen on the next read, keyed so one person's view never reaches another, and the budgets `test/snappy.test.ts` holds. `bun run bench/snappy.ts` prints p50/p95 and SQL statements per request for both pages, warm and cold. The content-addressed assets answer a revalidation with `304`.
- [`docs/METRICS.md`](docs/METRICS.md) — `GET /metrics` for Prometheus.
- [`docs/THREATS.md`](docs/THREATS.md) — who would attack the forge, what each wants, and the test behind every protection (`/resilience` reads it).
- [`docs/DOMAINS.md`](docs/DOMAINS.md) — the ways the forge stops, and what it says when each does.
- [`docs/SNAPSHOT.md`](docs/SNAPSHOT.md) — a forge back from a copy: what a nightly snapshot holds, where it goes, the drill, and the one command that restores it.
- [`docs/RECOVERY.md`](docs/RECOVERY.md) and [`docs/RESTORE.md`](docs/RESTORE.md) — the forge back at 3 a.m., and on a fresh machine; print them.
- [`docs/CLOUD.md`](docs/CLOUD.md) — clouds are capacity, never dependency, and the cloud accounts an admin keeps.
- [`docs/CLUSTER.md`](docs/CLUSTER.md) — the check lane as Kubernetes Jobs.
- [`docs/EXTRACT.md`](docs/EXTRACT.md) — the forge on a machine of its own, and the platform it grew up in switched off: what a host owes it, the moves in order, and what is given up.
- [`docs/ops/ROLL.md`](docs/ops/ROLL.md) — rolling a release.

**Design and records**

- [`docs/DESIGN.md`](docs/DESIGN.md) — the design system's spine; its sections are under `docs/design/sections/`.
- [`docs/SPIKE-CLOUDFLARE.md`](docs/SPIKE-CLOUDFLARE.md), [`docs/AUDIT-MANY-HANDS.md`](docs/AUDIT-MANY-HANDS.md), [`docs/BACKLOG.md`](docs/BACKLOG.md) and [`docs/research/`](docs/research/) — a spike, an audit, a backlog and research notes, kept as written.

What the crew's tokens bought is on the board (`/board/returns`), in MCP `returns`, and in the terminal: the palette's Usage carries a Returns line (dollars, runs, changes landed, cost per landed change; `[`/`]` move between 1, 7, 30 and 90 days), and Usage of a repository (`owner/name`) narrows it to one app. Owner facts only (`src/actions/returns.ts`); see [`docs/OPERATING.md`](docs/OPERATING.md).

The terminal's palette has `Signed in` for anyone signed in: your browsers, tokens and this terminal's key, with when each was last seen; `d` signs the selected browser out after a confirm, as `/settings` and MCP `sessions` do, and on a token revokes it after a confirm (Keep is the default) through the same `deleteToken` action as Settings and the API, so it stops working at once (`docs/CREW.md`, "Where you are signed in").

`/changelog` lists the last 30 releases of `FORGE_REPO` (public only) with their pulls, for anyone; the terminal's palette has `Changelog` for the same list. In the terminal, `/` takes a word and keeps the releases whose version or pull titles contain it (`esc` clears it); Enter on a release lists its pulls, and Enter on a pull opens it (`docs/features/changelog.md`).

A repository admin cuts a wave from two doors, both through `cutWaveFor` (`src/actions/cut_wave.ts`): Settings → *Cut a wave*, and `c` on the terminal's waves screen, which says how many pulls would go in, asks `cut wave N? y/n` (`y` and `n` choose outright) and shows the draft pull's number (Enter opens it). Each opens a draft pull listing the pulls merged since the last wave; nothing merged, an earlier wave that does not parse, or a viewer who is not an admin is refused in the action's words, writing nothing.
