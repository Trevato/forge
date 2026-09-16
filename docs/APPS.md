# Apps, runs, and the crew

A forge holds repositories. An **app** is a repository that runs — here, on
the forge's own port, with a production and a preview for every open pull —
and the **crew** is the set of agents who work on it while you are elsewhere.
This document is the contract between the two halves and the rest of the
forge: what the words mean, which rules are mechanical, and where the state
lives. `docs/ARCHITECTURE.md` explains the foundation these sit on.

The shape is Vercel's — you have apps, apps have previews, git decides what
is production and protects it — with one deliberate difference. The person
using it need not be a developer. They know what an app is, they can hold
"production data" and "preview data" apart in their head, and the golden path
asks nothing more of them than that. Developers and agents use the same
primitives underneath; nobody gets a second system.

## Vocabulary

- **App** — a repository that runs. A repository becomes an app explicitly
  (`New app`, or `Run as an app` on an existing one), the same way a
  repository is mirrored explicitly: a choice you can see and reverse. An
  app has a **slug**, the label its hostnames are built from.
- **Environment** — one place an app runs. `production` is the default
  branch. A **preview** is one open pull. Every environment owns a data
  directory, and nothing else does.
- **Deployment** — an environment at one commit: a checkout, a process, a
  port, a log. An environment routes to its _current_ deployment; a newer
  one takes over only once it answers.
- **Run** — a durable record of work the forge did on a commit. A `deploy`
  run installs, builds, tests, starts and waits for the app to answer. An
  `agent` run is an agent working on an issue or a pull. Runs are the
  **checks** on a pull.
- **Agent** — an account of kind `agent`. No password, no session; it acts
  only through tokens the forge mints for a run and destroys after it. It
  is a user in every other respect: it owns nothing you did not give it, it
  is granted access the way a person is (collaborator or team), and its
  name appears on the pull it opened.
- **Crew** — the agents with write access to a repository.

## Rules that are mechanical

Each rule below is enforced in a code path with a test that tries to get
around it. None is advisory.

1. **Production is the default branch, and agents cannot move it.** The only
   way code reaches production is the default branch moving. The crew
   works from forks: being on a repository's crew grants an agent read and
   the right to be assigned, nothing more, so the repository itself takes
   no push from it at all. Its branch lives in its own fork of the
   repository, made on first use, and the pull proposes it back;
   `mergePull` refuses an agent actor. An agent proposes; a person lands.
   (A merge gate that lands on its own once a review and the checks agree
   is a setting to add, not a rule to loosen.) Two corollaries keep an
   agent from starting a chain: an agent cannot assign anyone (assigning an
   agent is what spends money, and only a person may), and an agent cannot
   create a repository (it owns nothing it was not given; it may fork to
   contribute). A reviewer on the crew may still pass a verdict — request
   changes, approve — since a verdict gates nothing an agent could do.
2. **A preview lives exactly as long as its pull is open.** Opened: deployed.
   Pushed: redeployed at the new head. Closed or merged: stopped, and its
   data deleted. There is no orphan state; the sweep on boot rebuilds the
   set of previews from the set of open pulls.
3. **Preview data is a copy, never a window.** When a preview is created its
   data directory is cloned from production's at that moment (copy-on-write
   where the filesystem offers it — APFS, XFS, btrfs — a plain copy
   otherwise, and `empty` is a per-app choice). A preview process is handed
   its own `FORGE_APP_DATA` and nothing that names production's. Merging a
   pull moves code; it never touches data.
4. **A deployment is a check.** Every deploy is a run; the run's state is
   what the pull shows. With `require_checks` on, `mergePull` refuses
   `checks_required` until the head's deploy run is `ok`, read live inside
   the merge — never from a status a caller computed earlier.
5. **A private app answers only to someone the forge vouches for.** An app's
   `access` is `public` or `private` (defaulting to the repository's
   visibility), and it is set apart from the repository's own: the code can
   be private while the app is public, or the other way round. A private
   environment sets no cookie of its own; a person arriving by its link is
   sent to the forge to sign in, which checks `canRead` on the repository
   and returns them with a signed, short-lived grant for the page they
   wanted. Someone who cannot see the repository, and anything that is not
   a person navigating, gets the forge's own "not found". Guessing the
   hostname yields the same.
6. **A run's credential dies with the run.** An agent run gets a token
   scoped `rw` (no settings, no tokens, no administration) with an expiry,
   and the token is deleted when the run ends however it ends. It never
   appears in argv or a URL; git receives it through `http.extraHeader`,
   the same channel origins and the local client use.
7. **Runs are bounded.** Every run has a spend budget and a wall-clock
   limit. A pull gets a fixed number of automatic follow-up runs (a failed
   check, a request for changes) before the forge stops and says so; a
   person speaking on the pull resets the count. Nothing loops unattended.
8. **A child process inherits nothing it was not handed.** The forge's own
   environment holds secrets (an API key, an OAuth client secret). App and
   agent processes are started with an explicit environment — `PATH`,
   `HOME`, a locale, and the variables this document names — never the
   forge's.

## The golden path

What a person sees, in order:

1. **New app.** A name, and — optionally — a sentence about what it should
   do. The forge creates the repository with a small working app in it,
   makes it an app, and starts production. Seconds later there is a URL.
   If a sentence was given, it becomes the first issue, assigned to an agent
   on the crew, and the agent starts.
2. **A pull appears**, opened by the agent, with a preview. Open the preview
   (a link, or a QR code from a phone), use it. Leave feedback as review
   comments and a verdict. Request changes and the agent picks it up in the
   background; the preview updates when it pushes.
3. **Approve, merge.** Production redeploys from the default branch. The
   production data directory is untouched — the notes you took, the rows
   your app wrote, are all still there. The preview and its copied data are
   gone.
4. **Drop in whenever.** The dashboard lists apps with what is running, and
   **Needs you** — pulls waiting on a review — is the inbox. Everything
   else runs without you.

Nothing above required a terminal. Everything above is also reachable from
one, and from the JSON API, because each step is an action.

## How an app is declared

The repository says how to run itself, in `forge.json` at its root:

```json
{
  "app": {
    "run": "bun run src/server.ts",
    "install": "bun install",
    "test": "bun test",
    "health": "/",
    "ready": 30,
    "tty": "bun run src/tty.ts"
  }
}
```

Only `run` is required, and even it defaults: a `package.json` with a `start`
script is enough. `install` defaults to `bun install` when a `package.json`
exists and to nothing otherwise; `test` defaults to nothing; `health` is the
path polled until it answers; `ready` is the number of seconds to wait for
that before the deploy fails; `tty` is the app's terminal interface (below). The file is read from the commit being
deployed, never from the database — a pull that changes how the app runs is
previewed the way it will run.

The forge starts the app with:

| variable           | value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| `PORT`             | the port to listen on, chosen by the forge                               |
| `HOST`             | `127.0.0.1` — only the forge's proxy reaches it                          |
| `FORGE_APP_ENV`    | `production` or `preview`                                                |
| `FORGE_APP_DATA`   | this environment's data directory, created for it                        |
| `FORGE_APP_URL`    | the public URL this environment is served at                             |
| `FORGE_APP_COMMIT` | the commit being run                                                     |
| `FORGE_APP_PULL`   | the pull number, on a preview                                            |
| `FORGE_APP_SSH`    | the exact `ssh …` that opens this environment's terminal, when SSH is on |
| `FORGE_URL`        | the forge's own base URL                                                 |

A terminal session (`tty`) gets the same variables plus `FORGE_APP_TTY=1`
and `FORGE_APP_USER`, the forge account at the keyboard or empty for a guest.

An app that keeps its state under `FORGE_APP_DATA` gets production and
preview data for free. The scaffold does exactly that with `bun:sqlite`.

### Checks

A repository says how a change is checked, in the same file, beside or
instead of `app`:

```json
{
  "check": {
    "run": "bun x tsc --noEmit && bun test",
    "install": "bun install",
    "timeout": 1200
  }
}
```

The forge runs it against every commit a pull proposes — when the pull
opens, and each time its branch moves, a fork's included — and against
every push to the default branch, in a fresh export of that commit. The
verdict is a run of kind `check`, kept with its log beside the pull, in
the same place a preview's deploy reports and read by the same code: the
inbox badge, the pull's status, the crew. A failing check on an agent's
pull goes back to the agent with the log's tail, as a failed preview does,
bounded the same way. An app's own `test` still runs inside its deploy;
`check` is for a repository that is not an app, or an app whose check is
more than its test. `install` defaults to `bun install` when the package
declares dependencies; `timeout` is seconds, twenty minutes by default.
A `check` that is present and wrong fails with the reason, so a commit is
never silently unchecked. A check under way when the forge restarts is
queued again, and the forge that carries on runs it from the start.

### Environment

What an app needs that the repository must not carry — an admin password,
a payment key — an admin of the repository sets under **Settings → App →
Environment** (or `PUT /api/v1/repos/:owner/:name/app/env/:name` with a
`{ "value" }` body). A name is `ADMIN_PASSWORD`-shaped: capital letters,
digits and underscores; the names the forge sets itself (`PORT`, `HOST`,
`PATH`, `FORGE_*` and their kin) are refused, and the forge's own values
win regardless. Values are write-only: set one, and it is never shown
again — the page, the API and the event outbox carry the name and when it
was set, nothing more. At rest each value is sealed with the data
directory's key (`kernel/secret.ts`), bound to the app and the name.

The variables are handed to every environment: production, and every
preview, which inherits the current set the way it inherits a copy of the
data. A process reads its environment once, at start, so setting or
removing a variable redeploys production and every open preview at their
current commits. The install and test steps do not see them.

### The forge as an app of itself

The forge's own repository declares an app, so a forge can host the forge:
production runs `main`, and every pull gets a preview forge of its own —
the place to try a change that might not earn its keep, with the data it
would run against. The manifest is the whole trick:

```json
"app": {
  "run": "env FORGE_DATA=\"$FORGE_APP_DATA\" FORGE_URL=\"$FORGE_APP_URL\" FORGE_APPS=0 FORGE_SSH_PORT=0 FORGE_CHECKS=0 bun run src/main.ts",
  "install": "",
  "health": "/healthz",
  "ready": 90
}
```

The inner forge keeps its state under the app's data directory, so a
preview made with **copy** starts as a copy of the hosted one — the same
accounts, repositories and history, disposable. It answers at the app's
URL and nowhere else: no SSH listener, no apps and no crew of its own
(the outer proxy routes one label of hostname, not two), no checks. It is
handed none of the outer forge's secrets — an app's environment is only
what `Environment` above lists — so its first sign-up is its admin, as on
any fresh forge. `install` is empty because the forge has no dependencies
to fetch; `ready` is generous because the first boot migrates.

## A terminal for every app

The forge's own port answers `ssh`, and the login name picks what opens:
any name opens the forge's terminal UI, and an app's slug opens **that
app's terminal** — `ssh -p 2222 notes@forge` runs the app's `tty` command
on a real pty, in the deployed checkout, with the environment's own
variables (`FORGE_APP_DATA` and the rest, plus `FORGE_APP_TTY=1` and
`FORGE_APP_USER`, the forge account at the keyboard or empty for a guest).
`notes--12@forge` is the preview of pull 12's. The key still decides who
you are: a private app's terminal answers only to a key the forge knows
that can read the repository; a public app's answers to anyone, as its web
page does. Resizes pass through; closing the connection sends the program
`SIGHUP`.

The scaffold ships a small one (`src/tty.ts`, plain ANSI, no dependencies)
over the same SQLite file the web page uses, so a new app is reachable two
ways from its first minute. An app without a `tty` says so, in words, when
someone tries.

## Hostnames and the proxy

Apps are served from the forge's port by `Host`. With `FORGE_APP_DOMAIN`
(default: the forge's own host), production is `<slug>.<domain>` and the
preview of pull 12 is `<slug>--12.<domain>`. `--` cannot occur inside a slug,
so the two never collide. Where only single-label hosts are routable (a
wildcard certificate covers one label), give the attachment itself:
`FORGE_APP_DOMAIN=--forge.example` serves `notes--forge.example` and
`notes--12--forge.example`; a value that starts with a separator is used
whole, a bare domain gets the dot. Browsers resolve every `*.localhost` name to
loopback, which is what makes a laptop forge work with no configuration at
all: `http://hello.localhost:3000`.

The proxy is a `fetch` to the deployment's loopback port, streamed back.
Headers are forwarded with the usual `X-Forwarded-*` additions. An
environment that is not running gets a page from the forge that says so and
links the run — never a bare gateway error.

A websocket handshake (`Upgrade: websocket` with a key) goes through the
same gate — the private app's grant cookie, then a live port — and then the
forge opens its own socket to the app first, carrying the path, the query,
the cookie, `X-Forwarded-*` and the offered subprotocols. Only once the app
has accepted does the browser's side upgrade, with the subprotocol the app
chose; frames then pass both ways as they were sent, text as text and
binary as binary, and a close on either side reaches the other with its
code. A handshake the app does not accept, or an app that is not there,
gets the same "not running" page as a request would (502), never a socket
that opens and shuts. The limits: a frame is at most 16 MiB in either
direction; at most 16 MiB may wait for a browser that has stopped reading
before the socket is closed rather than the memory kept (the forge buffers
nothing of its own); and a socket that has sent nothing and answered no
ping for 120 seconds is dropped. The app's own 101 response headers are
not carried — a cookie an app sets on the handshake does not reach the
browser.

## A release does not drop a session

The forge is one process on one volume, and a release replaces it. The new
process comes up beside the old one and takes everything new once it is
ready; the old one drains: it starts no new crew runs and lets the ones in
flight finish and land (a run cut short is a person's money spent twice),
stops its apps and its checks, says so on `/healthz`, and keeps serving
whoever is connected over SSH until they leave — for up to an hour — and
only then goes. A run that does have to be cut short, by a crash or the
hour running out, is queued again to carry on in the clone it left, in the
same session. SQLite in WAL mode carries two processes for that window.
Each running run carries a lease its process renews every fifteen seconds;
a forge coming up fails only runs whose lease has lapsed, so the old
process's live work is never mistaken for a crash's leftovers, and a real
crash is still cleaned up within a minute or two.

## Where state lives

Git is truth for code. The app's serving configuration (slug, access, the
preview-data policy) is forge state, like a webhook. Everything else is
either derived or ephemeral:

```
<data>/apps/<app id>/production/data          production data — lives forever
<data>/apps/<app id>/production/<commit7>/    a checkout, one per deployment
<data>/apps/<app id>/pull-<n>/data            preview data — dies with the pull
<data>/apps/<app id>/pull-<n>/<commit7>/      the preview's checkout
<data>/runs/<run id>.log                      every run's log, appended live
<data>/crew/<agent>/<repo id>/<issue n>/      an agent's clone, kept while its pull is open
```

Rows: `app` (repo, slug, access, preview_data), `app_env` (name, sealed
value), `run` (repo, kind, issue, commit, state, summary, cost, timings),
`agent` (user, model, brief, budget), and `issue.assignee_id`. The current deployment of each environment is in
memory only: a process is not state, and a restart rebuilds every
environment from the default branch and the open pulls, exactly as
`core/reconcile.ts` rebuilds the index from git.

## Runs

A run row is created `queued`, claimed with a compare-and-swap into
`running` (two workers cannot both take it), and finishes `ok`, `failed` or
`cancelled` with a one-line summary. Its log is a file the surfaces tail live
through an in-process listener; the file is the truth, the listener is the
optimization. `run.queued`, `run.started` and `run.finished` ride the event
outbox like every other state change, so webhooks and the SSE stream see
them.

A run's page draws the log line by line as it is written — the tools the
agent reached for, the forge's own words, the agent speaking — with the
clock running and, at the end, what the run cost in money and turns. The
stream numbers every line, so a browser that reconnects hears only what
followed; nothing on the page reloads under a reader. Each agent's row on
the crew page carries the numbers that say how it is doing: runs and how
many landed, pulls a person merged, spend, and the mean cost, time and
turns of a run.

On a pull, the runs for the current head are its checks. A deploy run that
fails — install, build, test, or the app never answering — fails the check
and the preview shows the log where it stopped. A push makes new runs;
older ones are history, not status.

## The crew

An agent is created once (`New agent`: a name, a model, a brief) and given
access like anyone else. Work reaches it three ways, all off the event
outbox with a sweep behind the wake-up:

- **Assignment.** An issue assigned to an agent starts a run. The agent
  clones the repository, works on a branch named after the issue, and
  pushes. The clone is the triangle git was built for: it fetches from the
  repository and pushes to the agent's fork, so a plain `git push` lands
  where the agent may write and nowhere else. The forge opens the pull on
  its behalf, from the fork — the agent's closing message is the
  description — so the bookkeeping is never the agent's to get wrong.
  Assigning a pull re-engages the agent on that pull. A push to the fork
  moves the pull: the repository's snapshot of the branch and the preview
  built from it follow.
- **Feedback.** A review that requests changes, or a comment on the
  agent's pull that addresses it, starts a follow-up run that resumes the
  agent's session with the feedback quoted. A follow-up that begins after
  the pull was merged works on a fresh branch from the default branch and
  lands as a new pull that names the one it continues.
- **A failed check.** A deploy that fails on the agent's pull, or the
  repository's own check failing on it, starts a follow-up with the log's
  tail. Bounded by rule 7.

Forks follow their parents. A fork's default branch is a copy of the
parent's until someone commits on it, and while that is so the parent
moving is the fork moving — fast-forward only, as pushes land, a mirror's
sync included. A fork with commits of its own on that branch is left as it
is; `Update from parent` on its page (or `POST …/sync`) says so. This is
what lets one person's fork stand between the crew and the outside world:
the crew proposes into it, the person merges there, and proposes the
result onward as one pull (see `docs/ORIGINS.md`, "a fork of a mirror").

An agent may decline. A last message that starts with `DECLINED:` ends the
run as failed with that reason, posted on the issue or pull, and nothing it
touched is pushed — a mis-scoped task parks with an explanation instead of
becoming an empty or wrong pull.

A run's budget is not spent to the last cent on the task. The end of it —
fifteen percent, at least fifty cents, never more than half — is held
back, and an agent that spends the rest gets one short turn in the same
session to land what exists: run the tests, drop what is half-done, commit,
push, and write the description anyway. The pull says where the work
stopped and at what spend.

A run the provider turns away — a rate limit, a usage window that has
closed, an overloaded model — has nothing wrong with it, so it is not
failed. It pauses: the run ends cancelled with a `paused:` summary, its
clone is kept exactly as the agent left it, and its task is queued again
for a minute after the reset the provider named (fifteen minutes on, when
it named none). The run that starts then resumes the same session in that
clone and is told to carry on. A task is paused at most six times before
the forge stops waiting on it.

The agent runs Claude Code headless in its clone, with a prompt the forge
composes: who it is, what the task is, how to finish, and what will be
refused. Permissions are the forge's, passed as settings: file tools
confined to the clone, no prompts (anything that would ask is denied), a
spend budget, and Claude Code's own sandbox around the shell — seatbelt on
macOS, bubblewrap on Linux where it is installed — with a policy the forge
writes per run (`crew/sandbox.ts`): the network is the forge and the
package registry (plus `FORGE_CREW_ALLOW_HOSTS`); writes stay in the clone
and the temp dir; reads are refused for the forge's repositories, its
index and key, every other agent's clone, and the operator's own
credentials (`~/.ssh`, `~/.aws`, and their kin). The repository's own
`AGENTS.md` is read the way Claude Code always reads it, so a repository
can steer its crew without touching the forge.

The forge asks the host for one more binary than before: `claude`, found on
`PATH` or at `FORGE_CLAUDE`. Authentication is the operator's — an
`ANTHROPIC_API_KEY` or a `CLAUDE_CODE_OAUTH_TOKEN` in the forge's environment
is handed to the run, or the machine's own Claude Code login is used when
there is neither. When neither
works the crew page says so, in words, before anyone assigns anything.

## Configuration

| variable                  | default                         | meaning                                           |
| ------------------------- | ------------------------------- | ------------------------------------------------- |
| `FORGE_APPS`              | `1`                             | `0` runs no apps and no crew                      |
| `FORGE_APP_DOMAIN`        | the host in `FORGE_URL`/`_HOST` | what app hostnames attach to (`example` or `--x`) |
| `FORGE_APPS_CONCURRENCY`  | `2`                             | deploys running their heavy steps at once         |
| `FORGE_CREW_CONCURRENCY`  | `2`                             | agent runs at once                                |
| `FORGE_CREW_BUDGET_USD`   | `5`                             | spend per run unless the agent says otherwise     |
| `FORGE_CREW_TIMEOUT_MIN`  | `45`                            | wall-clock limit of one agent run                 |
| `FORGE_CREW_ALLOW_HOSTS`  | —                               | hosts an agent's shell may reach, comma-separated |
| `FORGE_CLAUDE`            | `claude` on `PATH`              | the Claude Code binary                            |
| `FORGE_CLAUDE_CONFIG_DIR` | Claude Code's own               | a `CLAUDE_CONFIG_DIR` for runs, when wanted       |
| `ANTHROPIC_API_KEY`       | —                               | handed to agent runs when set                     |
| `CLAUDE_CODE_OAUTH_TOKEN` | —                               | handed to agent runs when set                     |

The public URL apps and agents are told about the forge is `FORGE_URL` when
set, else `http://<FORGE_HOST>:<PORT>`; its scheme and port are what app
URLs are built with, so a forge behind TLS on a wildcard domain sets
`FORGE_URL=https://forge.example` and `FORGE_APP_DOMAIN=apps.example`.

## What is deliberately not here

Containers. An app runs as the forge's own user, in its own directory, and
nothing more separates it from the host than that. On the machine one
person owns this is the honest, fast answer; a sandboxed runtime is the
next layer, and the process boundary here is where it will attach. Custom
domains, TLS termination, and an approve-and-land gate are additions of
the same kind: the shapes above hold, and a new column or listener carries
each of them.
