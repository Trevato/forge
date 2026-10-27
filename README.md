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
The list leads with the forges that need you, each badged
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
Settings → Crew also shows, each only when it has something, a "Handed to the
planner" card (issues the crew parked twice: repo, issue link, when last
parked, why) and a "Restore drill" card (the last drill's pass or fail and
when). The terminal's palette has the same as "Crew hand-overs", a read-only
list of the same rows (repo#number, title, reasons; it does not open the
issue — use the link on the page). Both are a forge admin's only.

A hand-over card on `/asks` (an agent's pull the reviewer stopped on after three rounds) has "Give back to the crew": one press assigns the pull, and the open issue it closes if a person holds it, to the agent that opened it, writes "Given back to the crew by @who", and the card leaves; the next tick starts its run. It is for a writer of the repository, and a pull a person opened, or by an agent gone from the crew, gets no button. In the terminal, `b` on a handed-over row of the On you pane does the same (`src/actions/give_back.ts`).

A pull the merge queue holds as red alone (red on its own merge at its current head; cleared by a new head or a moved main) says so under its checks line: "red alone at <time>, waiting for a new head or a new main", on the pull page, its live checks line and the studio change step, and in the checks row of the pull's terminal screen (`redMark` in `src/checks/queue.ts`). Nothing is drawn when it is not held.

On a sealed issue, a writer gets the private repository to fix it in: `POST /api/v1/repos/:owner/:name/issues/:number/private`, the issue page's button, and `p` on the issue's terminal screen, which shows the repository and its clone URL (built from the forge's origin). All three refuse alike: not found for anyone who may not see sealed reports, `not_sealed`, and `unverified`.

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

Set `FORGE_REPO=owner/name` to the forge's own code and a pull the crew lands there is written to `$FORGE_DATA/releases/<sha>/` (the newest `FORGE_RELEASES_KEEP`, default 5, are kept), preflighted with that tree's own `--preflight`, and recorded in the `release` table (sha, landed pull, verdict, its line, when). A red preflight is asked again once (the copy of the live database can tear under load); a second red is logged and told to the landed pull. Other repositories are untouched, and nothing is swapped unless `FORGE_SELF_SWAP=1`: then the forge binds its port with SO_REUSEPORT, a green release is started from `releases/<sha>/` beside it on the same port (`FORGE_COMMIT` set to the sha), `/api/v1/health` is read until an answer names that sha and is well (`FORGE_SWAP_BUDGET_S`, default 60), and only then does this process drain as a SIGTERM does — except that it stops accepting at once, so every new connection is the release's, and answers what it already holds (a long push or clone) to the end, for up to five minutes, before it closes. A release not healthy in its budget is killed, the old keeps serving, and the log and the landed pull say so. One swap per process: a landing while another swap is in its budget, or after one succeeded, is released and recorded but not started (the new process runs it from the next restart). The SSH terminal is not handed over yet (the new process cannot bind the old one's port), so a process holding the SSH listener refuses the swap and tells the landed pull; run with `FORGE_SSH_PORT=0` to swap. The swap also needs `net.ipv4.tcp_migrate_req=1` (Linux 5.14+): without it the kernel resets the connections still queued on the old listener when it closes, so a swap is refused (and told to the landed pull) rather than failing requests. The release is a child of the old process, so the swap is for a forge run directly, not under a supervisor that kills its children when the old process exits (PID 1 of a container, a systemd unit with the default `KillMode=control-group`). SO_REUSEPORT lets any process of the forge's user bind the same port and take a share of its connections, so `FORGE_SELF_SWAP=1` assumes nothing else runs as the forge's user on the host network (agents and apps are sandboxed or in cells). `--rollback <sha>` starts the kept release beside the running forge by the same health-read swap (`FORGE_SWAP_BUDGET_S` does not apply: it waits the default 60s), and a release that is not healthy is killed with the old still serving. It refuses, with one line and exit 1, a sha that is not kept (never checked out, or pruned) and a release whose schema has fewer migrations than the live database has applied (`<sha> predates schema N; rolling back would need a down-migration`); a release with a newer schema is allowed, as it migrates forward on boot, and the database's refusal of a future schema is unchanged. It does not drain the forge that was serving: until part 2 of the rollback does, both processes share the port and the operator stops the old one (the command prints that). It does not check `tcp_migrate_req` or SSH either; stopping the old process cleanly needs the same `net.ipv4.tcp_migrate_req=1` setup as the swap, and the SSH port stays with the old process. `/releases` lists the kept releases (short sha, landed pull, when, and since when the live one has been healthy: this process's start); a person who writes the `FORGE_REPO` repository (never an agent: the button is hidden and the POST is a 403) gets a Roll back button on a kept, schema-compatible release, which runs the same refusals and swap and then drains this process (so it needs `FORGE_SELF_SWAP=1`); only readers of that repository and site admins see the page and the home line (anyone else gets a 404), and the forge's SSH terminal has the same, gated the same (`src/release/gate.ts`): the palette's `Releases` shows `live: <sha> since <time>` and the kept releases, only to those readers, and Enter on a rollable release asks to confirm then runs the same rollback as the button (a person who writes the repository only, never an agent; told when `FORGE_SELF_SWAP` is off); the home carries a `live: <sha> since <time>` line linking there. `FORGE_REPO` also names the parent code that spawned child forges fork.

**Keeping a domain drill**: `POST /api/v1/drills` (a site admin person; an agent is refused with 403, and a session needs a same-origin request) takes `{domain, seen:{health, board}, backSeconds}`: a domain key from `docs/DOMAINS.md`, what the drill read from health and the board (text, at most 8000 characters each), and whole seconds until the forge was well again (0 to 31536000). The body is capped at 32000 bytes (413). It answers 201 `{id, domain, backSeconds, green, why}`: the verdict is judged against the domain's own words and kept whether green or red. An unknown domain, bad `seen` or bad `backSeconds` is 422. Kept drills are read back on **Settings → Backups**, in its **Failure domains** card (`docs/SNAPSHOT.md`). To run a drill by hand, `FORGE_TOKEN=… bun scripts/drills/run.ts <domain> --forge <url>` (plain `http` is refused unless the host is loopback or you pass `--insecure`) prompts for the fault, watches health and the board until the forge is back, and posts this for you (`docs/DOMAINS.md`).

**Re-checking a shared red**: `POST /api/v1/repos/:owner/:name/checks/recheck` (a repository admin, `admin` token scope; anyone else gets 404, and a session needs a same-origin request) takes `{test}`: the name of one failing test exactly as the check log's failing names show it, 1 to 300 characters (otherwise 400). It asks again, through the ordinary check queue, for every open pull whose latest check on its current head failed on that test, and answers `{queued: [pull numbers]}`. At most 50 pulls are queued per call; when more were red, the answer adds `more` (how many were left) and a `message`, and a second call takes the rest. A pull waiting for a writer's approval, or whose head declares no check, is not in `queued`.

If your shell already has `FORGE_URL` set — a crew workspace sets it to the
forge you work for — this forge takes it as its own canonical address and
refuses every form a browser posts to `localhost`: run it with
`env -u FORGE_URL bun run src/main.ts`, or set `FORGE_URL` to wherever you
will actually browse it.

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
(`GET …/pulls/:number`, and MCP's `pull` tool). `GET …/pulls/:number?diff=0` reads the pull without its diff (and skips computing it); `diff` is `0` or `1`, default `1`, and anything else answers 422. `GET …/issues?fields=brief` lists issues with only number, kind, title, state, labels, assignee, author, originAuthor, authorIsAgent, createdAt and updatedAt (and `untrusted` where it applies); no bodies or comments. `fields` is `brief` or left out, and anything else answers 422 `invalid_fields`. `GET …/repos/:owner/:name/events` answers `{ items, next_cursor }`, newest first, `limit` 1 to 200 (default 50) and `cursor` from `next_cursor` (anything else is a 422); it used to answer a bare array of every event, so a client that read the array reads `items` now. A request reads at most 1,000 events, so when most of them are hidden from the reader a page can come back short with a `next_cursor`: keep following it until it is null. MCP's `events` tool answers the same. `GET …/repos/:owner/:name/branches` answers `{ items, next_cursor }` in the order it always had, `limit` 1 to 200 (default 50) and `cursor` the `next_cursor` of the page before (the name of the last branch on it); anything else is a 422, and a cursor naming a branch deleted between two requests is `invalid_cursor`, so start over. It used to answer a bare array, so a client that read the array reads `items` now.

### Proposing to a parent forge

A spawned forge can offer its own change to the forge it came from. The
parent mints a proposal token for the child (above); the child keeps it in
`parent.json` as `"proposal": {"child": "kid", "token": "…"}` beside the
parent's address. On the child's `/<org>/forge/following` page a writer
presses **Propose to the parent forge** (or `POST …/following/propose-parent`):
the default branch is pushed to `child/<name>/<branch>-<tip>` at the parent,
and the pull opens there, titled by the change that landed last and naming it
(`org/forge#7`). Asking again for the same tip returns the pull already made.

The repository's admin changes how the forge follows its parent (`tell-me` or
`take-updates`) from the radio form on the same page, with `PATCH
/api/v1/forge/following {"mode"}`, with the MCP `follow_mode` tool, or by pressing `m` on the chain screen in the terminal. The
record in `parent.json` is rewritten atomically and a `forge.follow_mode` event
is appended. A non-admin is refused (403), a value outside the two modes is
422, and a severed forge is 409; each leaves `parent.json` untouched.

**Take the N new commits** (shown to the admin on `/<org>/forge/following` when
the parent is ahead, `POST /api/v1/repos/:owner/:name/following/take`, the MCP `take_updates`
tool, or `t` on the chain screen in the terminal) opens, or updates, the one `forge/take-updates`
pull whatever the follow mode, and never moves the default branch; a conflict
opens the converge issue instead, and nothing behind answers "Already up to date."

The page and `GET …/following/proposals` show each proposal as open, merged or
closed, read from the parent (the token may read back only pulls it opened) and
cached for a minute (only a signed-in viewer makes the parent get asked); a merged or closed one is final. A parent that does not
answer shows the last state with "parent unreachable" — never an error page.
In the terminal, the Chain card lists the proposals and `p` proposes. The MCP `propose_to_parent_forge` tool (writer only) proposes with the page's
words, and `forge_proposals` lists each proposal with its state and "parent
unreachable" where that applies. No dependency was added. Left out: a UI to paste
the token into `parent.json` (part 2 of #2182 covers minting and handing over).

Minting, listing and revoking go through one action
(`src/actions/proposal_tokens.ts`) at every door, and only a writer of the
repository may; anyone else is told "no such resource here, or it is not
visible to you", as the API says it. The secret is shown once, on minting.
The repository's settings page is one more door: a writer sees their proposal
tokens one to a line (child, origin, expires, last used) with Revoke, and a
form that mints one and shows its secret once; others see no section.

The check cell's memory is on the same page under **Check cell**, and in the terminal on a repository's About card (`I`, for an admin): the limit the machine enforces, read from `forge.json` on the default branch. When `check.limits.memory` asks for more than the machine's ceiling it shows both numbers and where the cut comes from (`FORGE_CELL_MEMORY_MAX_MIB`, else a share of the pod's memory); otherwise one number. The ceiling is read once and kept (`src/apps/check-memory.ts`).

- **MCP**: the `proposal_tokens` tool with `repo` and a `verb`: `mint`
  (`child`, `origin`, optionally `childRepo`), `list` (the ones you minted for
  the repository) or `revoke` (`id`).
- **Terminal**: `ctrl+k`, **Proposal tokens**, then the repository as
  `owner/name`. `n` mints (the child's name, then its https address) and shows
  the secret once on its own screen; `x` revokes the one under the cursor.

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
```

`sync` never merges, rebases, resets or checks anything out. `--ff` is the one
exception and it fast-forwards a repo only when the tree is clean, nothing is
ahead, no rebase or merge is half-finished, and `merge-base --is-ancestor` has
proved that moving the branch cannot lose a commit. A dirty repo is reported
and left exactly as you left it.

`forge` with no arguments opens the local UI on the same runtime as the SSH
one: the library of clones, then a lazygit-shaped working-tree screen —
`space` stages, `enter` opens the hunks, `s` stages one, `c` commits, `P`
pushes, `b` branches, `l` log, `z` stashes, `?` shows every binding.

Build it once and put it on your PATH:

```sh
bun build --compile src/cli/main.ts --outfile dist/forge
```

That produces a self-contained binary (it embeds the Bun runtime, so expect
something in the 60–110 MB range; `dist/` is gitignored and binaries are never
committed). Until you build it, `bun run src/cli/main.ts …` is the same
program.

## Develop

```sh
bun test              # protocol-level + adversarial suite
bun scripts/design-lint.ts   # no colour or off-scale font-size beyond docs/design/baseline.json, no class docs/DESIGN.md §5 does not name
bun scripts/cold-read.ts <url> [--repo owner/name] [--write [--allow-text-only]] [--file-issues N [--file-into owner/name]]   # cold-read audit (#5882): a no-context model reads the top pages (signed in with FORGE_TOKEN, sent only to FORGE_URL's forge; the signed-in pages go to the model endpoint, so use a throwaway account) at 390 and 1440 px; needs ANTHROPIC_API_KEY
bun x tsc --noEmit    # zero type errors is the standard
bun run check         # exactly what the forge runs against every push
bun run check:record  # the same, and rewrites scripts/test-times.json
```

The design check (`test/design-lint.test.ts`, run in the gate) fails a pull that
adds a colour literal or an off-scale `font-size` beyond
`docs/design/baseline.json`, or defines a class `docs/DESIGN.md` §5 does not
name; the message names the file or the class. The way out is to use a token
(`var(--…)`) or a component §5 names; a new component is named in its own
`docs/design/areas/<area>.md`. When a change lowers the counts, run `bun scripts/design-lint.ts
--update` and commit the baseline; when it deletes the last rule for a class
in the §5d register, strike the name there too. See `docs/design/plan.md`.

`docs/DESIGN.md` is a spine: each of its sections is its own file under
`docs/design/sections/` (§5d is `5d-page-local-classes.md`), linked from the
spine in order, and the check reads them in that order. A new section is a
new file and a new line in the spine.

`bun run check` is the gate: the same command `forge.json` declares, so what
it says here is what the deploy will say. It type-checks once, then runs the
test files `scripts/gate.ts` admits — every `test/*.test.ts` not in its
`EXCLUDED` — as parallel `bun test` shards
(`scripts/test-shards.ts`): one per CPU the process may use, no more than
one per 512 MiB of the memory its cgroup allows (16 on the 16-CPU, 8 GiB
check cell; the old ceiling of eight left half of it idle, #2038), and
`FORGE_CHECK_SHARDS=2` turns that down on a small or busy host. Each
shard's output is written whole as it finishes; the log ends with every
failing test from every shard, or on green with one line — how many tests,
across how many files, in how long, then the slowest and fastest shard.

A shard of several files that goes red gets a second chance for its failing
files, first three only: each is run once alone, same flags and env. A file
that passes alone was red only beside others and no longer fails the check;
the shard's log (and the tail) carries `test-shards: fails only beside
others: <file> (shard-mates: …)`. Only failed tests clear: if the report
holds an error (a file that threw while loading, an unhandled error, a
crash before the summary) nothing in that shard is retried, and a file that
fails alone stays red. `--record`, `--impact` and one-file-per-process runs
never retry. The cleared file is reported in the log only; filing it as an
issue is not built yet (#2480).

Two things keep a test's setup in milliseconds (#2038). `bunfig.toml`
preloads `test/helpers/preload.ts`, which hashes passwords at argon2id's
floor (8 KiB, one pass) instead of Bun's default 64 MiB, two passes:
making an account and signing it in was ~700 ms of a typical `beforeAll`
and is now ~15 ms; the forge itself never loads it. And `openDb` keeps
the empty database each migration list makes: the second fresh database
in a process is a copy of it rather than ninety-odd migrations again
(`createApp` ~100 ms → ~6 ms). No test file runs one subject long
enough to set the gate's floor alone: the studio's and the apps
adversarial suites are split by subject into `test/studio*.test.ts` and
`test/apps-adversarial*.test.ts`.

The check's first step is the gate-list audit (`bun scripts/gate.ts`), so an
`EXCLUDED` entry for a file that is gone, or one with no reason or issue,
fails in under a second,
before install-heavy work. `tsc` then runs `--incremental` with a 2 GB heap,
its build info in `.forge-cache/` (made first with `mkdir -p`: tsc will not
create the directory, and a checkout with no restored cache failed on it,
#1881). It is TypeScript 7, the native compiler (a
Go binary, so the bound is `GOMEMLIMIT=2GiB`): on this tree a cold check is
~3 s and ~17 CPU-s where 5.9 took ~30 s and ~50 CPU-s (#1864). 5.9 stays as
the dev dependency `typescript-api` only because `scripts/hollow.ts` walks
its AST, which 7.0 has no stable JS API for. The forge restores
`.forge-cache/` from the base's own green check and keeps it only from green checks of the default
branch (`src/checks/cache.ts`), so a pull's code never fills a cache another
check reads. The full gate also writes every file's time there, and the next
split weighs every file by measurement rather than the 41 the table named.

The fast tier picks by measurement. The full gate runs each file in a
`bun test` of its own under Bun's coverage (`--impact`; coverage is per
process, so a shard of many files would blur theirs together) and writes
the impact map: test file → the `src/**` files whose functions it called.
A file merely imported — its top level run, none of its functions — does
not count; that is the import graph again (#1794). Under the forge the map
is handed over as `$FORGE_CHECK_IMPACT` in the checkout: every check is
seeded with the one the last green default-branch run kept (under
the forge's data directory, `checks/impact/`, `src/checks/impact-store.ts`), and
only such a run, or the full gate on land, keeps a new one. By hand it is
`scripts/test-impact.json`. A diff intersected with it is the set of tests
the change reaches; the plan line says `by coverage: N changed files reach
M tests; src/x.ts reaches none` (a coverage gap). A measured test is
guessed by imports only against the changes the map cannot see; tests the
map has never seen fall back to the import-hop guess, and a change to
`forge.json`, `package.json`, `scripts/**` or `src/kernel/**` runs
everything. With no map yet the line says `by imports (no impact map)`.

Files go to shards by how long they take, not how big they are: longest
first onto the least-loaded shard, weighed from `scripts/test-times.json`
(file → seconds, from one recorded run). A file the table does not name
weighs its bytes at the table's own seconds-per-byte. If the table is
malformed, the log says it was refused and the split falls back to bytes.
A stale table only makes the split less even; it never drops a file.
Refresh it with one command after adding a slow test file, or when the
log's slowest shard is well over 1.5× its fastest:

```sh
bun run check:record  # the gate's own command, with test-shards.ts --record
```

`--record` runs each file as its own `bun test`, with as many running at
once as the gate runs shards. It rewrites the table only when every file
is green. Files it did not run keep their old times.

Every file is independent (its own forge, its own database, port 0), so a test that fails only beside another is a bug
in that test. Two things it will not do:

- **It never borrows your git configuration.** A test drives a real `git`
  against a forge it booted a second ago, and builds that child's
  environment rather than inheriting yours (`test/helpers/git-client.ts`) —
  otherwise a `GIT_CONFIG_COUNT` in your shell (a crew run sets one, holding
  its own forge credential) would send that credential to the test's server
  and every push in the suite would come back `401`.
- **It skips what this machine cannot run, out loud.** The OpenSSH interop
  tests need `ssh` and `ssh-keygen`; without them the log says `SKIPPING:`
  and names the tool (`test/helpers/tools.ts`). Install OpenSSH and they run
  again — the skip is conditional on the binary, never on anything else.

Every `test/*.test.ts` is in the gate unless `EXCLUDED` names it with a
one-line reason and the issue that owns admitting it, so a new test file is
gated the moment it exists and no pull edits a shared list for it (#2037).
`test/check-list.test.ts` goes red on an exclusion named twice, without a
reason or issue, or for a file that does not exist. An excluded file rejoins
the gate by deleting its `EXCLUDED` entry in a pull whose check is green and
whose description carries ten green runs in random order under load:
`bun scripts/flake-hunt.ts admit test/x.test.ts` runs the file ten times, each
its own `bun test --randomize` with a fresh seed beside busy loops, prints the
record and exits non-zero unless all ten are green.

A brand-new test file does not need that record: it joins the gate on its
own green check, not ten runs. That is accepted on purpose — a flaky new
test can turn the gate red once before anyone sees it — and the nightly
flake hunt below is the backstop that files it and quarantines it.

**No flaky tests.** Nightly, `.forgejo/workflows/flake-hunt.yml` runs every
gate file five times on a loaded box, each run a fresh seed that orders both
the files and (through `--randomize`) the tests inside them, nothing stopped
early. A file red in some runs and green in others is flaky: the hunt files
a `Flaky: test/x.test.ts` issue carrying the failure text, the seed and the
run, with the usual root causes to tick (a shared port, a real clock, order
dependence, a leaked server, a timeout set near the real duration, a tight
wall-clock bound); then
`bun scripts/flake-hunt.ts quarantine` moves every file an open `Flaky:`
issue the hunt itself filed (its author is the token's user and the forge
has not marked it untrusted) into `EXCLUDED` under that issue and proposes
the move as a pull; a file the issue names that no longer exists is skipped,
since its exclusion would turn the audit red. Nobody hand-edits the list. A file red in every run is broken,
not flaky, and the check already says so. The fix is the test's shape, never
a retry: `test/flake.test.ts` fails on `--retry`, `--rerun-each`, a bunfig
`retry` or a `{ retry: N }` anywhere the gate runs, and on any test that
bounds a measured time under 200 ms (a loopback fetch on a loaded runner
takes tens of ms): assert relative to a baseline from the same run, or bound
only the failure the test names. The workflow needs a
`FORGE_TOKEN` secret and a `FORGE_URL` variable on the mirror.

**No unseen red outside the gate.** Nightly, `.forgejo/workflows/outside-gate.yml`
runs `bun scripts/flake-hunt.ts outside --file-issues`: every file in
`EXCLUDED` (the complement of the gate, from the same list, so a file moved
into the gate is no longer run there), once, one at a time, with the gate's
60 s timeout. A file that newly fails opens one `Red: test/x.test.ts` issue
naming its first failing test; still red on another test, it updates that
issue; still red on the same test, it says nothing, so the owner's asks show
it once; passing again, it closes the issue. Same `FORGE_TOKEN` and
`FORGE_URL` as the hunt.

Bun's own `--randomize --seed=N` drives every hunt and admission run. Not
used: `--rerun-each` (one seed for every rerun, so ten reruns explore one
order) and `--parallel` (it changes the load the gate is judged under).

The gate also refuses hollow work. `test/hollow.test.ts` runs
`scripts/hollow.ts`, which names an exported function in `src/actions/` that
nothing that runs reaches — no route's handler, MCP tool, crew worker, CLI
command or terminal screen, followed from where the program starts — and a
screen — a GET path with no parameter that draws a page — that no reachable
page links to. `scripts/hollow-allow.ts` lists what main
carries today, each entry under the issue that owns it; an entry that is no
longer hollow turns the check red, so the list only shrinks.
`bun scripts/hollow.ts` prints the same lines on their own.

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

- **A run page's live log** rides the page's one `/events` connection (its
  `run.log` frames); it opens no stream of its own. Known gaps, both silent: a
  frame the server cuts for size (64 lines or 16 KB) loses its omitted lines
  until the next reconnect's catch-up read, and a run whose log was already cut
  to its last 512 KB at render gets no catch-up read. The page says
  "Reconnecting" while the connection is down.

- **Cut a wave** — Settings → *Cut a wave* (repository admins, same-origin
  POST; web-only, the terminal's settings hand over to the web) opens a pull
  adding `waves/<next>.md`, listing the pulls merged since the last wave and
  not already in an earlier wave. The headline and highlights are `TODO`
  placeholders; no model is called. It refuses, writing nothing, when an
  earlier wave does not parse (naming the file) or nothing new has merged.
  `/:owner/:name/waves` lists the waves on the default branch, newest version
  first, each line opening `/:owner/:name/waves/<version>` (headline, date,
  highlights with why, pulls as links; linked from that settings card); in the
  terminal, `V` in a repository opens the same list and Enter (or a click) on
  a row opens the same wave as plain text (a live browse of another forge says
  waves are only read on this forge).
  `/:owner/:name/waves.atom` is the same list as an Atom feed (newest 50, each
  entry the headline, its highlights and a link to the wave), advertised from
  the waves page; a private repository's feed is a 404 to anyone who cannot
  read it.

- **Accounts & access** — register/sign in, personal access tokens with coarse
  scopes (ro/rw/admin), public and private repositories.
- **Git** — push and pull over HTTPS **and SSH**, browse code (tree, blob with line anchors,
  commit history) with README rendering and **syntax highlighting**, protected
  default branches (force-push and deletion refused, honest fast-forwards
  allowed).
- **System memory** — `/system`, for a forge admin who is a person (anyone else gets 403): the forge's RSS beside its JS heap (`heapStats()` from bun:jsc), hourly mean and max for the last 24 h, drawn on the server. Sampled once a minute into `memory_hour` in `app.db` (a week kept). RSS rising while the heap stays flat is native memory growth.  In the terminal the same admin has a **System memory** command in the palette: the last 24 hours as text rows (hour, RSS mean/max, heap mean/max in MiB), read-only. The account menu links `/system` for that admin.
- **Flow alarms** — a firing alarm (red main, a stuck approved pull, an idle crew, no release for 90 min) shows as one linked line above home's feed and on `/boards` (admin), under the vitals line of the terminal's Flow dialog and home, as one phone notification when it starts (not repeated while it stands), and in the `flow` tool's `alarms` (MCP, `/api/v1/telemetry/flow`; an agent's cut to public repositories). Nothing firing draws nothing.
- **Boards** — `/boards` also shows the pipeline (a row per stage, the bottleneck named) and the held counts (why each autonomous repository's ready issues wait; private repositories included), for the same admin who is a person; they sit as two cards under the board list, not as panels of a board, because they are not saved queries. The terminal's Boards screen does not draw them: its door to the same rows is the **Flow** dialog. `/boards/data`, for a forge admin who is a person (anyone else
  gets a 404 on the page): the query is the URL (`?source=runs&aggregate=count&by=day&fcolumn=state&fvalue=failed`),
  drawn server-side as the chart chosen beside it (`chart=line|bar|area|number|table|heat`)
  with its points in a table; a point opens the rows behind it, keeping your filter.
  `series=<column>` splits each group by a second column: stacked area draws one band per
  value (eight at most, the rest folded into "other"), the heat strip one row per value
  (twelve at most) with time across, the table a series column; line, bar and number set
  it aside. Number is the latest group's value over a sparkline of all of them.
  `/boards` holds the boards themselves: a board is one JSON file
  (`{title, range, refresh: off|10s|1m, panels: [{title, chart, query, w, h}]}`) in
  `forge/boards`, a repo the forge owns and makes on the first boot with an admin; every save is a commit
  by the admin who made it, and a file that does not validate is not shown. Make, rename,
  duplicate, delete, add/edit/remove/reorder panels, or pin the query on `/boards/data`.
  Any panel has **Pin to home** / **Unpin** on its board page (a same-origin POST); pins are per admin, kept in `board_pin` (slug + panel title + position, `boards/pins.ts`), and home draws them under the KPI row in that person's order with Up, Down and Unpin beside each (`web/studio/pinned.ts`). A pin whose panel is gone is skipped, does not count toward the limit of 24, and is dropped at that person's next pin; nobody sees another's pins. All doors go through `actions/board-pins.ts` (an admin who is a person; anyone else gets not-found):
  - the page (Pin to home / Unpin on `/boards/:slug`, Up / Down / Unpin on home);
  - the terminal: on a board's screen `[` `]` mark a panel, `p` pins or unpins it, `<` `>` move a pinned one; the dashboard lists the pinned panels by title;
  - `GET /api/v1/boards/pins` (the list, in order) and `POST /api/v1/boards/pins` with `{"op":"pin|unpin|move","slug":"…","title":"…","by":-1|1}` (`by` for move only);
  - the `board_pins` MCP tool (no `op` lists; `op` pin, unpin or move changes). `pins` is therefore not a board slug.
  The first boot also writes the starting boards, **Usage**, **Serving**, **Crew**, **Releases**, **Apps**, **Security**, **Throughput**, **Reach** and **Forges**; Serving is the forge's event-loop lag p99 beside the checks and crew runs running, so checks' concurrency is raised on numbers. Apps' per-app panels show repo ids until a source exposes a safe name; Security (sign-ins, failed sign-ins, tokens by scope, admin actions, from the admin-only `signins`, `tokens` and `adminActions` sources and `usage`) shows no token text, hash, payload or IP; Throughput is items entering each stage from issue to live, per hour, from the `stages` source. Each is written once: `.offered` in that repo records them, so an edit stays and a deletion sticks.
  A live board (any `refresh` but `off`; the form offers off or on, and `10s` and `1m` are still accepted and mean the same) redraws its grid when a run, pull, check, issue or usage event arrives, through the live-region swap
  (`/boards/:slug/live`, etag'd, one fetch per burst). The same doors are in the API: `GET /api/v1/boards`, `GET|PUT|DELETE /api/v1/boards/:slug`, and each panel's data as JSON or CSV at `GET /api/v1/boards/:slug/panels/:id?from=&to=&step=5m&format=csv`, bucketed in SQL to the step and never cut short (`docs/APPS.md`); each panel's card links `json` and `csv` (a plain download link) beside `explore`
  (an agent or anyone but an admin is 403; a panel whose query cannot run is refused with 422). The same four doors are MCP tools (`boards`, `board_write`, `board_delete`; `boards` with a `slug` reads one, and with a `panel` too that panel's data, with the same `from`, `to` and `step`) and, for the same person, a **Boards** screen in the terminal that lists boards and shows a board's panels as text, each with what its data holds now (a time panel's last bucket and step, another's row count). No dependency was added.
- **Parked work** — the terminal's Flow dialog says how many issues the crew parked (an open issue whose newest comment is the crew's `Parked by the crew` note) in the last 24 h and 7 d, and names the newest three; the MCP `flow` tool returns the same as `parked`. See `docs/TOUR.md`.
- **Issues** — labels, threaded comments, close/reopen, markdown.
- **Pull requests** — open from a branch, a **beautiful diff viewer** (syntax
  highlighting composed with intra-line word highlighting, mobile-first,
  collapsible files), merge-commit and squash strategies, conflict detection,
  and merge commits kept reachable forever via `refs/pull/N/merged`.
- **Review comments** — anchored to a diff line by content hash, so a
  force-push re-anchors them or marks them outdated, never misplaces them.
- **Forks** — alternates-backed (instant, storage-bounded), with cross-repo
  pull requests (fork → upstream) and detach-before-delete safety.
- **Organizations & teams** — orgs own repos; teams grant read/write/admin
  resolved through membership.
- **Live updates** — a server-sent-event stream turns comment threads live and
  flags new activity, no refresh.
- **Commit pages** — every commit's diff through the same viewer.
- **Settings** — visibility, branch protection, and labels.
- **The check lane is visible.** Checks run one at a time; an admin's home
  strip, the terminal dashboard's strip and `GET /api/v1/health` (`lane`) show
  the queue depth, the running check and its age, the median of the last
  twenty and the time to clear, and the 30-minute queue card names that cause.
- **A terminal UI** — `ssh` in for the whole forge: dashboard, code browsing
  with syntax highlighting, issues and pulls with live-updating threads, the
  diff viewer with inline review comments, merges, settings, orgs, tokens and
  keys. Six themes, remembered per account.
- **Origins** — connect GitHub, Forgejo or Gitea (device code, PKCE, or a
  pasted token), mirror repositories in with their issues and pulls, and write
  through to the origin on every comment, state change, label and push. Pins
  say what the local client keeps cloned.
- **Automation** — a JSON API covering repos, issues, forks, and orgs (the
  label-as-queue surface), a durable event outbox, and **webhooks** (HMAC-signed
  delivery with retry). Every send goes through `src/kernel/outbound.ts`:
  - https URLs only; the host is resolved, private addresses are refused, and no redirect is followed.
  - A refused delivery fails at once, with the reason shown on the hooks page.
  - An unreachable or erroring endpoint is retried with growing delay.
- **Where an account came from** — `GET /api/v1/admin/accounts` lists each
  account with `via` (`signup`, `edge`, or null) and `signsInThrough`
  (`"open-platform.sh"` for an account the platform edge made, else null);
  Settings → Accounts and the new-account line in the inbox say "signs in
  through open-platform.sh" for the same accounts. The terminal and the MCP
  have no accounts list to carry it.
- **Removing an account** — `DELETE /api/v1/admin/accounts/:username` (admin
  only). An account that is the last owner of an organization answers 409 with
  the organizations named. Send `{"retireOrgs": true}` to preview: the answer
  lists each organization, its repositories (and the app each runs) and its
  teams, and changes nothing; the account's own repositories and the app each
  runs are listed too, under `own`. Send `{"retireOrgs": true, "confirm": true}` to
  do it: apps are stopped, repositories deleted, organizations retired (the
  name stays taken), then the account. If a repository will not go, the answer
  is 500 with `failed` and `removed`; what is left is intact and the same call
  again finishes the job. The accounts page offers the same flow: Remove →
  "Remove the organization too" → a confirm page listing everything that goes.
- **Apps** — a repository that runs: production on the default branch, a
  preview per open pull with its own copy of the data, served by hostname
  from the forge's own port, every deploy a run and every run a check.
- **The crew** — agents as accounts with nothing but a run-scoped token,
  working issues in the background with Claude Code and proposing through
  pulls a person merges.

Pages render without a line of JavaScript and are designed thumb-first. Six
premade themes (from warm paper to polar night) switch instantly and persist in
a cookie — even that works script-free. Still **zero runtime dependencies**.

Not yet: containers around apps, custom domains, and a gate that lands a
pull on its own once review and checks agree.

## Where the rest is

This page is the front door. Everything else is a file of its own under
`docs/`, each about one thing:

**Using it**

- [`docs/VISION.md`](docs/VISION.md) — what the forge is for, and the order of work.
- [`docs/STUDIO.md`](docs/STUDIO.md) — the front door in full: the five words and where each is decided, the box, the three lists, a tell, a run and a change each on its own page, and the board.
- [`docs/TOUR.md`](docs/TOUR.md) — every other page and screen, with each of its doors: the terminal over SSH, the home and its figures, review, signing in, the page-view beacon, the board's notes, long threads, who can see a repository, archive, where a repository came from, big directories, search, sharing to the forge, link-preview cards and choosing among variants.
- [`docs/ASKS.md`](docs/ASKS.md) — what waits on you and how to answer it: waiting pulls, mutes, wave proposals, feed chips and the decider.
- [`docs/FEED.md`](docs/FEED.md) — the feed: what happened, ranked, each item with why it is there.
- [`docs/PULLS.md`](docs/PULLS.md) — resolving a conflicted pull without a clone.
- [`docs/GIT.md`](docs/GIT.md) — cloning over HTTPS and SSH, and partial clones of big repositories.
- [`docs/ROLES.md`](docs/ROLES.md) — guest, member and admin, and what each may do.
- [`docs/MCP.md`](docs/MCP.md) — the forge as a connector; [`docs/STANDARDS.md`](docs/STANDARDS.md) is what it answers by default: `.well-known`, feeds, cards, the manifest.

**Apps and the crew**

- [`docs/APPS.md`](docs/APPS.md) — the contract for apps, previews and runs: making an app, the vocabulary, and the rules that are mechanical rather than advisory.
- [`docs/CONTRACT.md`](docs/CONTRACT.md) — who may do what, as a table: an app's `contract.json`, the one evaluator every app decides with, the audit that reads it from git, the probe that knocks on the running app, and the wall a person alone crosses.
- [`docs/WEBSPEC-PREVIEWS.md`](docs/WEBSPEC-PREVIEWS.md) — the website specification run over every preview, report-only.
- [`docs/CREW.md`](docs/CREW.md) — the crew: agents, how a run works, review, live triage, the merge queue, spend, roles and invites, the sandbox, passports, and the direction a vision pull will write.
- [`docs/SENTINEL.md`](docs/SENTINEL.md) — the forge hunting its own faults; [`docs/HUNT.md`](docs/HUNT.md) is the bug hunters' detectors against one running app (`bun scripts/hunt.ts <origin>`).
- [`docs/FLOW.md`](docs/FLOW.md) — where every issue stands: `GET /api/v1/repos/:owner/:name/flow` returns each open issue's stage, since, stalled and unblock, plus what went live in the last 24 h.
- The flow panel on `/boards` and the terminal Flow dialog say how the open crew pulls sort into piles (red, conflicted, changes asked, approved and waiting, awaiting review), each pull counted once in the first pile it fits (`src/flow/pile.ts`).
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
