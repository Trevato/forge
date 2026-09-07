# forge

A software forge you can read in an afternoon and mold by hand.

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
bun run src/main.ts  # web on :3000, ssh on :2222
```

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

## Live in the terminal

`ssh` into the forge and you get the whole thing — repositories, code, issues,
pull requests with a real diff viewer, review comments, merges, settings,
tokens and keys — as a keyboard-driven terminal app. The same port serves git.

```sh
ssh -p 2222 localhost                        # the terminal UI
git clone ssh://localhost:2222/you/hello.git # git, same port
```

Your SSH key is your identity. A key the forge knows signs you straight in; any
other key browses public repos as a guest and can press `s` to sign in with a
username and password — which links that key to your account, so the next
connection is instant. `j`/`k` to move, `enter` to open, `esc` to go back, `/`
to filter, `?` for the keys, `:` for the command palette, `t` for the theme.

Working on the UI itself? `bun run src/tui/main.ts --user alice` runs it over
stdio against your local data directory. That `--user` flag is a development
convenience and exists only there: over SSH, the key decides who you are and
nothing else can.

Configuration is environment variables, all with defaults: `FORGE_DATA`
(`data/`), `PORT` (`3000`), `FORGE_SSH_PORT` (`2222`; `0` turns SSH off), and
`FORGE_HOST` (`localhost`, the hostname in clone URLs). Connecting origins
adds `FORGE_URL` (the canonical public base URL, needed for OAuth callbacks),
`FORGE_GITHUB_CLIENT_ID` / `FORGE_GITHUB_CLIENT_SECRET`, and
`FORGE_ORIGIN_ALLOW` (hosts an operator vouches for on a LAN). Behind a
platform edge that signs people in for every app it serves, `FORGE_EDGE_TOKEN`
is the edge's secret: a request carrying it and `X-Plat-User` is that person,
signed in by the platform, with an account made on first sight. Everything a forge
instance _is_ lives under the data directory — the SQLite index, the bare
repos, and the SSH host key, in plain layout. Tar it up and it moves.

## Origins

Your forge is the index of everything you work on, wherever it actually lives.
An **origin** is a connected account on another forge — GitHub, Forgejo, Gitea.
Mirror a repository in and its issues, pulls, comments and labels come with the
git objects; anything you then do here is **written through** to the origin
first and reflected locally after it succeeds. For a mirror the origin is
truth, exactly as git is truth for a native repo.

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
- **Every deploy is a run**, and the run is the check on the pull. Turn on
  **require checks** and a pull cannot merge until its head is green.
- A **private** app answers only to someone the forge has vouched for
  (`canRead` on the repository, then a signed grant); a public one to anyone.
- **Every app has a terminal.** `ssh -p 2222 <name>@<forge>` runs the app's
  `tty` command from `forge.json` on a real pty over the environment's own
  data; `<name>--<pull>@<forge>` opens a preview's. The scaffold ships one.

The repository says how it runs in `forge.json` (`run`, and optionally
`install`, `test`, `health`, `ready`); a `package.json` with a `start` script
is enough on its own. The forge hands the process `PORT`, `FORGE_APP_DATA`
(this environment's directory — keep state there), `FORGE_APP_ENV`,
`FORGE_APP_URL` and `FORGE_APP_COMMIT`, and nothing from its own
environment. Browsers resolve `*.localhost` to loopback, so a laptop forge
needs no DNS at all; elsewhere point a wildcard at it and set
`FORGE_APP_DOMAIN`.

## The crew

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

The forge asks the host for one more binary: `claude`, on `PATH` or at
`FORGE_CLAUDE`, authenticated as the operator (an `ANTHROPIC_API_KEY` in the
forge's environment is handed to runs; the machine's own Claude Code login
works when there is none). `FORGE_CREW_CONCURRENCY` (2) and
`FORGE_CREW_BUDGET_USD` (5) bound it; `FORGE_APPS=0` turns apps and crew off.
`docs/APPS.md` is the contract: the vocabulary, and the rules that are
mechanical rather than advisory.

## Develop

```sh
bun test              # protocol-level + adversarial suite
bun x tsc --noEmit    # zero type errors is the standard
```

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
