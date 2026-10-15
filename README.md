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

Git hosting, code browsing, and a JSON API in one fast Bun process, with
**zero runtime dependencies** — the `package.json` dependency list is empty and
stays that way. Everything worth having is written here: the Result type, the
router, the SSR templates, the design system, the markdown renderer. The only
thing forge asks of the host is a `git` binary.

Forgejo is the reference for what a forge should _feel_ like. This is that
feeling on a foundation sized for one person.

## Run it

```sh
bun install          # dev-only: types + tsc, no runtime deps
bun run src/main.ts  # web on :3000, ssh on :2222 (FORGE_SSH_PORT=0 turns it off; a taken port turns it off with one warning)
```

If your shell already has `FORGE_URL` set — a crew workspace sets it to the
forge you work for — this forge takes it as its own canonical address and
refuses every form a browser posts to `localhost`: run it with
`env -u FORGE_URL bun run src/main.ts`, or set `FORGE_URL` to wherever you
will actually browse it.

The first account you create becomes the admin — from the browser, the API, or
a terminal (`ssh -p 2222 localhost` on a fresh forge offers to create it). Then:

```sh
# mint a token, create a repo, push to it
curl -sX POST localhost:3000/api/v1/users \
  -d '{"username":"you","email":"you@forge.dev","password":"a-good-passphrase"}'

TOKEN=$(curl -sX POST localhost:3000/api/v1/tokens \
  -d '{"username":"you","password":"a-good-passphrase","name":"cli","scope":"rw"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

curl -sX POST localhost:3000/api/v1/repos -H "authorization: Bearer $TOKEN" \
  -d '{"name":"hello","visibility":"public"}'

git clone "http://you:$TOKEN@localhost:3000/you/hello.git"
```

The commits the forge writes for you — merges, squashes, reverts, web edits —
carry `you@users.noreply.<forge host>`, never your account email. Choosing your
real address is an opt-in under **Commit email** in `/settings` (or
`PATCH /api/v1/user` with `{"commitEmail":"account"}`); commits you push
yourself carry whatever your own git says.

## Live in the terminal

`ssh` into the forge and you get the whole thing — repositories, code, issues,
pull requests with a real diff viewer, review comments, merges, settings,
tokens and keys — as a keyboard-driven terminal app. The same port serves git.

```sh
ssh -p 2222 localhost                        # the terminal UI
git clone ssh://localhost:2222/you/hello.git # git, same port
```

On a host that cannot hold cells or the crew's shell sandbox, a site admin
sees `Reduced protection: …` in one line, under the filter on the terminal's
first screen and in the web footer; nobody else does, and a fully protected
forge shows nothing.

Your SSH key is your identity. A key the forge knows signs you straight in; any
other key browses public repos as a guest and can press `s` to sign in with a
username and password — which links that key to your account, so the next
connection is instant. `j`/`k` to move, `enter` to open, `esc` to go back, `/`
to filter, `?` for the keys, `:` for the command palette, `t` for the theme.

**Milestones.** `:` → *Milestones in a repository* → `owner/name` lists a
repository's limbs in the order the crew takes ready work (`enter` opens a
limb's own limbs). A person who administers the repository presses `r` to
Raise or `l` to Lower the limb under the cursor: a preview of the new order
and of the top of the ready list first, then `enter` to apply (`esc` backs
out), then `u` to undo the last move. It is the same fleet operation the web
milestones page uses, and a move is heard by that page when it is open.
Anyone else sees the order and no keys to change it; a guest sees only what
the web shows them.

Working on the UI itself? `bun run src/tui/main.ts --user alice` runs it over
stdio against your local data directory. That `--user` flag is a development
convenience and exists only there: over SSH, the key decides who you are and
nothing else can.

Configuration is environment variables, all with defaults: `FORGE_DATA`
(`data/`; the forge refuses to boot when it is the checkout itself or a path
inside it that git does not ignore), `PORT` (`3000`), `FORGE_SSH_PORT` (`2222`; `0` turns SSH off), and
`FORGE_HOST` (`localhost`, the hostname in clone URLs). Connecting origins
adds `FORGE_URL` (the canonical public base URL, needed for OAuth callbacks),
`FORGE_GITHUB_CLIENT_ID` / `FORGE_GITHUB_CLIENT_SECRET`, and
`FORGE_ORIGIN_ALLOW` (hosts an operator vouches for on a LAN). Behind a
platform edge that signs people in for every app it serves, `FORGE_EDGE_TOKEN`
is the edge's secret: a request carrying it and `X-Plat-User` is that person,
signed in by the platform, with an account made on first sight. Mail out
(the link that proves a newcomer's email) is SMTP submission over TLS,
configured by the forge-level secrets `MAIL_SMTP_URL`
(`smtps://user:pass@host:465`) and `MAIL_FROM`, set live under Settings →
Secrets, or at boot by `FORGE_SMTP_URL` / `FORGE_MAIL_FROM`. With neither, no
mail is sent and a newcomer waits for the owner to verify them. Behind a
proxy, `FORGE_TRUSTED_PROXIES` (comma-separated CIDR ranges, e.g.
`10.42.0.0/16` for a k3s ingress) names the proxies allowed to say who the
client is; limits for strangers and the signup audit then see each outside
client, read from `X-Forwarded-For` right to left past the trusted hops, or
from `FORGE_CLIENT_IP_HEADER` when the edge sets one (`cf-connecting-ip`
behind a Cloudflare tunnel, where the ingress rewrites `X-Forwarded-For`;
read only from a listed proxy). Once set, only the listed ranges are proxies:
this machine is not one unless listed, since every app runs beside the forge.
Unset, only this machine may say so, and the named header is never read. Everything a forge
instance _is_ lives under the data directory — the SQLite index, the bare
repos, and the SSH host key, in plain layout. Tar it up and it moves.

## Origins

Your forge is the index of everything you work on, wherever it actually lives.
An **origin** is a connected account on another forge — GitHub, Forgejo, Gitea.
Mirror a repository in and its issues, pulls, comments and labels come with the
git objects; anything you then do here is **written through** to the origin
first and reflected locally after it succeeds. For a mirror the origin is
truth, exactly as git is truth for a native repo.

A pull from an outsider's fork on the origin is someone else's code, so its
check and preview wait. A person with write access lets that exact head run:
on the pull page, **Approve to run here**; in the terminal, `A` on the pull
("approve to run here"); over the API, `POST
/api/v1/repos/:o/:n/pulls/:n/approve-here`. It is a local record — a review
written through to, or imported from, the origin never counts — and a new push
waits for a new approval.

Connect one at **Settings → Origins** (or `A` then `o` in the terminal). Which
way in you get is a property of the forge, not a preference:

- **GitHub** — a device code. The forge shows a short code and a URL; you type
  the code on whatever device has a browser, and the forge does the polling.
  This is the flow that works over SSH with no browser on the server. Setting
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

Only the person who connected an origin can write through it. Another writer
gets `origin_owner_only` rather than a comment appearing upstream under
someone else's name with someone else's token.

**Pins** are the bridge to the next section: the pin toggle on a repository
header (`p` on a row in the terminal, `P` on a repo's home) says "keep this on
my machine", and the dashboard grows an **On your machine** card listing them.
The server remembers only the choice — nothing about the state of a laptop —
and `forge sync` below is what acts on it.

**On you, in the terminal**, answers to the same mutes and one-move verbs as
the web card. Repositories you muted are hidden and counted ("2 repositories
muted"). On the On you card: `space` marks a row, `x` closes the marked rows
(or the row under the cursor) with one reason, `m` mutes their repositories,
`S` ships them, `u` undoes the latest set within its day, and `L` listens
again to every muted repository. Each goes through `applyAsksBulk`, so the
per-row access checks and refusals are the web's, shown in the toast.

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

## Apps

A repository that runs. Press **New app**, give it a name and — if you like —
a sentence about what it should do. Seconds later it is serving at
`http://<name>.<your forge's host>` from a small, real app (notes in a SQLite
file), and if you named an agent, the sentence became issue #1, assigned.

- **Production is the default branch.** The only way code reaches it is that
  branch moving, and an agent cannot move it: the crew proposes through
  pulls, a person merges.
- **Every open pull gets a preview** at `<name>--<pull number>.<host>`,
  redeployed on each push and gone when the pull closes. Its data starts as
  a copy of production's — copy-on-write where the filesystem can — and
  never writes back. Merging moves code and touches no data.
- **A run has a budget** (`src/kernel/budgets.ts`): a check past `gate`
  (60 min) or a reviewer's run past `review` (10 min) is killed with
  `budget: <what> took <n> min, limit <m>`, queued again once, and failed
  the second time, which the vitals carry as a need for a day. `gate` is 60
  min because this repository's own gate takes 18–25 min alone and 45 beside
  another check; it comes down when the gate does.
- **Every deploy is a run**, and the run is the check on the pull. Turn on
  **require checks** and a pull cannot merge until its head is green.
- A **private** app answers only to someone the forge has vouched for
  (`canRead` on the repository, then a signed grant); a public one to anyone.
- **Every app has a terminal.** `ssh -p 2222 <name>@<forge>` runs the app's
  `tty` command from `forge.json` on a real pty over the environment's own
  data; `<name>--<pull>@<forge>` opens a preview's. The scaffold ships one.
- **A new app starts trustworthy.** The scaffold's door asks the app's
  contract before a body is read, every change and refused change is an
  audit row, the API describes itself at `/openapi.json`, `/healthz` says
  up, and the look is design tokens, light and dark, with no colour spelled
  out anywhere else ([docs/APPS.md](docs/APPS.md#what-a-new-app-starts-as)).

The repository says how it runs in `forge.json` (`run`, and optionally
`install`, `test`, `health`, `ready`); a `package.json` with a `start` script
is enough on its own. The forge hands the process `PORT`, `FORGE_APP_DATA`
(this environment's directory — keep state there), `FORGE_APP_ENV`,
`FORGE_APP_URL` and `FORGE_APP_COMMIT`, and nothing from its own
environment. Browsers resolve `*.localhost` to loopback, so a laptop forge
needs no DNS at all; elsewhere point a wildcard at it and set
`FORGE_APP_DOMAIN`.

With a sentence and **Pick for me**, the sentence becomes a plan before the
page comes back: `src/crew/plan.ts` makes one non-interactive call to
`claude` — the quickest model, a fixed JSON shape, at most 3 seconds — for a
short checklist and a crew pick, so issue #1 opens as a checklist already
assigned to whoever the plan named, instead of a paragraph and a dropdown.
It costs one small model call per app made this way (a few tenths of a
cent), never blocks the repository or the app starting, and a bad or slow
answer is the same as none: no pick, no checklist, exactly what naming an
agent yourself already does. `FORGE_APP_PLAN=0` turns it off; so does having
no `claude` on `PATH` — either way **Pick for me** stops being offered and
`New app` behaves exactly as it did before this existed.

## The crew

In a preview (`FORGE_APP_ENV=preview`, which the platform sets) the crew is
off: no autonomy tick, no dispatch, no spend; checks still run and everything
can still be read. The boot log and the studio's crew card say so. Set
`FORGE_CREW_IN_PREVIEW=1` to run it anyway.

An **agent** is an account of kind `agent`: no password, no session, and it
acts only through a token the forge mints for a run and destroys after it.
An admin creates one (**Settings → Crew**, or `POST /api/v1/agents`) with a
model, a brief in its own voice and a spend budget; a repository admin puts it
on the repository's **crew**, which is the one grant an agent can hold — it
reads and writes that repository and administers nothing.

Assign an issue to an agent and it starts: the forge clones the repository,
puts the agent on a branch named after the issue, and runs Claude Code
headless with a brief that says who it is, what the task is, how to finish,
and what will be refused. When it stops, the forge pushes what it committed,
opens the pull (the agent's last message is the description), and the
preview comes up. Leave feedback on the pull — a comment, a request for
changes, a line comment — and the agent picks it up in the background,
resuming its session. A failed check re-engages it too, a bounded number of
times before a person must speak.

**Already done.** A builder that finds its issue already built on the base
branch declines with `DECLINED: already done on main in <commit>`, naming the
full or abbreviated id of each commit that did it (at most five). The forge
checks that every commit named is on the base branch; only then is the run
an "already done" outcome, with no strike and nothing parked. The issue stays
open with a note naming the commits, the asked list and the issue page say
"Done on main", and the person who asked closes it (the page's Close button,
or `x` on the issue in the terminal); the close writes "Closed: already done
on main in …" on the thread. A claim with no commit, or with one that is not
on the base, is an ordinary decline and is parked as one.

An autonomous app's planner is **held** while nothing is landing or the plate
is full: no pull has merged in 48 h while one was closed unmerged, or more than
`slots × 3` ready, unassigned issues are waiting. The tick log says which
(`planner: held`), and the board and the terminal's repository list say it in
words. A comment on the direction issue from someone who may write there lifts
the hold; an issue handed to the planner is still owed its pass.

The forge asks the host for one more binary: `claude`, on `PATH` or at
`FORGE_CLAUDE`, authenticated as the operator (an `ANTHROPIC_API_KEY` in the
forge's environment is handed to runs; the machine's own Claude Code login
works when there is none). `FORGE_CREW_CONCURRENCY` (2) and
`FORGE_CREW_BUDGET_USD` (5) bound it; `FORGE_CREW_CEILING_USD` caps what the
crew may spend across every repository in a UTC day, whatever each
repository's own ceiling says; `FORGE_APPS=0` turns apps and crew off. A preview whose pull nobody has
pushed to or commented on for `FORGE_PREVIEW_IDLE_DAYS` (default 3; `0` keeps
every preview warm) is stopped and reads as asleep, and asking for it wakes it.
An admin with more than one Claude account keeps them under Settings →
Subscriptions, sealed, and grants each to a repository (Settings → Crew) or
an organization (its page), down to one crew member: a work plan pays for
the work repositories and nothing else. Two on one grant take turns, and
one the provider rests hands its runs to the other until the reset.
**Sandbox.** An agent's shell is held to a policy — the network is the forge
and the package registry, writes stay in the clone, the forge's data and the
operator's credentials are unreadable — by bubblewrap and socat on Linux
(both are in the image). Inside it a builder can install the declared
packages, type-check, and run the tests that boot a server: no unix socket is
let through, so the run carries `FORGE_TEST_SOCKET=port` and the forge listens
on a loopback port instead (`bun scripts/sandbox-probe.ts` prints each
verdict). A host that forbids unprivileged user namespaces
(many container platforms' seccomp profiles) cannot hold it, and the policy is
then switched off rather than faked. To tell which a deployment is in: the
boot log carries `agent sandbox not available here` with the reason, Settings →
Crew shows **Unsandboxed** with it, and every agent run's page says
"Sandboxed" or "Unsandboxed" from what it was actually started with (runs
from before this record say nothing).

`docs/APPS.md` is the contract: the vocabulary, and the rules that are
mechanical rather than advisory.

`docs/PLANNING.md` is how issues depend on issues: the edge, the map, and
what "ready now" means to a person and to the crew. The map also shows each
pillar's ask-to-live: the median hours from an issue opening to its change live
in production, over the last 7 days (also in the map and milestones API and MCP).

`docs/STUDIO.md` is the front door from the top of this page in full: the five
words and where each is decided, the box, the three lists, a tell, a run
and a change each on its own page, and the board.

`docs/CONTRACT.md` is who may do what, as a table: an app's `contract.json`,
the one evaluator every app decides with, the audit that reads it from git,
the probe that knocks on the running app, and the wall a person alone
crosses.

`docs/FOLLOWING.md` is a fork that keeps up with its parent: where it
stands, taking updates, and the crew's part when both sides moved.

`docs/FLEET.md` is one change across many repositories, runs or issues: a
query, a dry-run plan of every row before → after, a receipt, and undo.

`docs/MCP.md` is the forge as a connector, and `docs/STANDARDS.md` is what
it answers by default: `.well-known`, feeds, cards, the manifest.

`docs/SNAPSHOT.md` is a forge back from a copy: what a nightly snapshot
holds, where it goes, and the one command that restores it.

A snapshot uploads eight objects at a time. Run logs older than a day go up
bundled per day (cut at 4 MB, so a long history is several objects, never one
huge one); restore unpacks them. While one runs, progress shows on
**Settings → Backups** and as a line in the log every 500 objects or minute.
The terminal has no backups view, so it has no readout.

`docs/EXTRACT.md` is the forge on a machine of its own, and the platform it
grew up in switched off: what a host owes it, the moves in order, and what is
given up.

### The sentinel

The forge hunts its own faults (`docs/CREW.md`): a hunt an hour on the
autonomy clock, sooner when a held slot or a setting left away from its
default is new. Each finding is one issue with its evidence, filed in
`FORGE_SENTINEL_REPO` (default `trevato/forge`) as the `sentinel` agent, else
the first admin. Evidence is scrubbed of anything credential-shaped before it
is filed.

- **Board:** a site admin's forge strip shows the open findings and the last
  hunt; a guest or member sees nothing.
- **Terminal:** press `ctrl+k`, run **Sentinel** — the same line as a toast.
  Offered to site admins only.

### Passports

A crew run's environment carries `FORGE_PASSPORT`, a 15-minute credential
scoped to `health:read` for the forge alone (`src/kernel/passport.ts`, no
dependency: Node crypto's HMAC and HKDF). It opens one route and nothing else:

    curl -H "authorization: Passport $FORGE_PASSPORT" "$FORGE_URL/api/v1/passport/health"

Missing, expired, wrong-audience, wrong-scope or forged passports get a 401. A
passport has exactly one valid encoding (padded or altered variants are refused).

This route proves the mechanism and is not a privilege: it returns what the
anonymous `GET /api/v1/health` already returns. The next edge should guard
something only a passport may reach.

## Cloud accounts

**Settings → Cloud accounts** (admins) holds provider keys — Cloudflare,
DigitalOcean, AWS, Azure, Fly, Backblaze — sealed and write-only. Pasting one
makes the forge check it with read-only calls (listed in the header of
`src/cloud/providers.ts`) and say what it can see; a key the provider rejects
is not stored. It is sealed at forge scope as `CLOUD_<PROVIDER>_<NAME>` (secret
names are capitals, so `cloudflare/main` is `CLOUD_CLOUDFLARE_MAIN`). The page
lists names, the last check, and which run last opened each key; "Every read"
lists each open, and a run's page lists the secrets it held. A run gets a key
by declaring it like any secret. **Write allowed** is off by default: a run
that adds `writes: yes` to its front-matter and declares a cloud key whose
switch is off fails with that reason. The switch gates the forge's hand-out,
not the key — a provider key that can write still can, so paste read-only keys.
**Audit** reads one account and opens one `[audit]` issue per finding (unattached
volumes, powered-off droplets, unassociated IPs, never-active zones) with a
monthly saving estimate, skipping findings already open. It runs in the forge,
not as a crew run; AWS audits look at us-east-1 only; over-provisioned
droplets and forgotten DNS records need metrics or resolution and are not
attempted; Backblaze audits find nothing yet. No dependency was added.

## Share to the forge

Install the forge to your home screen, then Share a link or text to it from
any app: the home composer opens with it as a draft, and it is only sent when
you tap Post. Signed out, you sign in (or up) first and land on the same
draft. The share target is the web manifest's `share_target`, which only an
**installed PWA on Android and Chrome** offers; iOS Safari does not.

## Develop

```sh
bun test              # protocol-level + adversarial suite
bun x tsc --noEmit    # zero type errors is the standard
bun run check         # exactly what the forge runs against every push
bun run check:record  # the same, and rewrites scripts/test-times.json
```

`bun run check` is the gate: the same command `forge.json` declares, so what
it says here is what the deploy will say. It type-checks once, then runs the
test files `scripts/gate.ts` lists in `GATE` as parallel `bun test` shards
(`scripts/test-shards.ts`): one per CPU the process may use, at most eight,
and `FORGE_CHECK_SHARDS=2` turns that down on a small or busy host. Each
shard's output is written whole as it finishes; the log ends with every
failing test from every shard, or on green with one line — how many tests,
across how many files, in how long, then the slowest and fastest shard.

The fast tier picks by measurement. The full gate runs each file under
Bun's coverage (`--impact`) and writes `scripts/test-impact.json`: test
file → the `src/**` files it executed. A diff intersected with it is the
set of tests the change reaches; the check line says `N changed files
reach M tests; src/x.ts reaches none` (a coverage gap). Tests the map has
never seen fall back to the import-hop guess, and a change to `forge.json`,
`package.json`, `scripts/**` or `src/kernel/**` runs everything. Until a
release commits the map, the fast tier guesses by imports as before.

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

Every `test/*.test.ts` is either in `GATE` or in `EXCLUDED` with a one-line
reason and the issue that owns admitting it; `test/check-list.test.ts` goes
red on a file in neither, in both, or named without existing, so a new test
file never sits outside the gate silently. A file joins the gate by moving
from `EXCLUDED` to `GATE` in a pull whose check is green and whose description
carries ten green runs in random order under load:
`bun scripts/flake-hunt.ts admit test/x.test.ts` runs the file ten times, each
its own `bun test --randomize` with a fresh seed beside busy loops, prints the
record and exits non-zero unless all ten are green.

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
has not marked it untrusted) names from `GATE` to `EXCLUDED` under that issue and proposes the move
as a pull. Nobody hand-edits the list. A file red in every run is broken,
not flaky, and the check already says so. The fix is the test's shape, never
a retry: `test/flake.test.ts` fails on `--retry`, `--rerun-each`, a bunfig
`retry` or a `{ retry: N }` anywhere the gate runs, and on any test that
bounds a measured time under 200 ms (a loopback fetch on a loaded runner
takes tens of ms): assert relative to a baseline from the same run, or bound
only the failure the test names. The workflow needs a
`FORGE_TOKEN` secret and a `FORGE_URL` variable on the mirror.

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

- **Accounts & access** — register/sign in, personal access tokens with coarse
  scopes (ro/rw/admin), public and private repositories.
- **Git** — push and pull over HTTPS **and SSH**, browse code (tree, blob with line anchors,
  commit history) with README rendering and **syntax highlighting**, protected
  default branches (force-push and deletion refused, honest fast-forwards
  allowed).
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
  delivery with retry).
- **Removing an account** — `DELETE /api/v1/admin/accounts/:username` (admin
  only). An account that is the last owner of an organization answers 409 with
  the organizations named. Send `{"retireOrgs": true}` to preview: the answer
  lists each organization, its repositories (and the app each runs) and its
  teams, and changes nothing. Send `{"retireOrgs": true, "confirm": true}` to
  do it: apps are stopped, repositories deleted, organizations retired (the
  name stays taken), then the account. If a repository will not go, the answer
  is 500 with `failed` and `removed`; what is left is intact and the same call
  again finishes the job.
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

## Fuzz and chaos

Invariants are proven by faults, not by hope. No dependencies were added.

- **Fuzz** (`test/fuzz-parsers.test.ts`, helper `test/helpers/fuzz.ts`): the
  manifest and check parsers, `contract.json`, hostnames, slugs, markdown, the
  diff reader and the API's JSON bodies take a seeded generator's cases. A
  failure prints `FUZZ_SEED` and the shrunk case; rerun with
  `FUZZ_SEED=<n> FUZZ_RUNS=<n> bun test test/fuzz-parsers.test.ts` and keep the
  case as a fixed test in `test/fuzz-found.test.ts`.
- **Chaos** (`src/chaos/`): a side instance on a fresh temporary data directory
  (it cannot name the live forge or a customer's app) takes four faults —
  SIGKILL mid-run, a dropped SQLite connection, a temp area that refuses writes
  (a stand-in for a full disk; nothing is actually filled), a delayed loopback —
  and after each asserts: no run vanished and all are in a known state, the
  database is whole and every open pull's head is in its repo, a snapshot taken
  afterwards restores, no sealed value is in any file in the clear.
  `test/chaos.test.ts` runs a small version in the gate (`CHAOS_SEED=<n>`).
- **Nightly**: `bun src/chaos/run.ts [--seed N] [--rounds N] --report` with
  `FORGE_URL`, `FORGE_TOKEN`. A broken invariant files an issue (fault, seed,
  log) and stands it under the umbrella `FORGE_CHAOS_PILLAR_ISSUE` (the
  P0 Trust issue waits for it); a quiet night comments one line on
  `FORGE_CHAOS_RECOVERY_ISSUE`. Scheduling it is the operator's: this repo
  ships the command, not a timer.

## Check tiers

`forge.json`'s `check` may declare `fast` beside `run` (the full gate; `full` names it explicitly). `bun scripts/test-shards.ts --tier fast --diff <base>..<head>` runs the tests that touch the diff (changed, named for a changed source file, or importing one within two hops), every test the times table records under 1 s, and any named by `--learned a,b`. `src/checks/tiers.ts` decides; it adds no dependency.

In the forge itself: a pull's check runs `fast` when the manifest has one, in a clone holding the fork point and the head as `FORGE_CHECK_BASE` and `HEAD` (`origin/main` is not a ref there), with `FORGE_CHECK_LEARNED` naming tests earlier land attempts taught the pull (`src/checks/history.ts`, `learned.ts`). Landing (`landIfGreen`) runs `full` once on the merge with its base before merging (`src/checks/landing.ts`); red comments on the pull with the tests named, is remembered per head and base, and the files ride the pull's next fast run. The pull page's checks line shows the tier words.

## Limits

Every limit the owner can hit is declared in `src/settings/limits.ts` with its default, bounds and reason, and changed live by a forge admin at `/admin/limits`, `PUT /api/v1/admin/limits/:key` or the `limits` MCP tool (never by an agent). Each change is kept with who made it.
