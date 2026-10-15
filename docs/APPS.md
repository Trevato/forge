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
   A pull from someone who cannot write the repository is the exception:
   its preview and its check run nothing until a person who can write
   approves that exact head, and each new push waits for a new approval
   (`core/pull_trust.ts`). A writer's own fork, and the crew's, run as
   before; an approval by the crew does not count.
3. **Preview data is a copy, never a window.** When a preview is created its
   data directory is cloned from production's at that moment (copy-on-write
   where the filesystem offers it — APFS, XFS, btrfs — a plain copy
   otherwise, and `empty` is a per-app choice). A preview process is handed
   its own `FORGE_APP_DATA` and nothing that names production's. Merging a
   pull moves code; it never touches data. A copy the build cannot read —
   its process exits before it ever answers, most often a migration on
   `main` the pull's commit predates — is tried exactly once more on an
   empty data directory before the deploy is failed; production is never
   seeded from a copy, so this never applies to it.
4. **A deployment is a check.** Every deploy is a run; the run's state is
   what the pull shows. With `require_checks` on, `mergePull` refuses
   `checks_required` until the head's deploy run is `ok`, read live inside
   the merge — never from a status a caller computed earlier. Install still
   comes first, but `test` and `start` run side by side: the environment is
   swapped in and serving the moment the app answers, and the run stays
   `running` — checking, not blocking — until `test` finishes and decides
   `ok` or `failed`. A deployment that answers is what was asked for; the
   suite going green is confirmed a few seconds later, not stood in front
   of the door. That instant is recorded, not just logged: the run's
   `servingAt` is stamped once, at the swap-in, distinct from `startedAt`
   (the deploy's own start) and `finishedAt` (which waits on `test`
   beside it) — so how long a change took to reach its preview is a
   number the forge can read back, not a line buried in the log. A page
   words that number from `createdAt`, the instant the push created the
   run, because the deploy may have waited on the concurrency gate for a
   permit first: `servedPhrase` (`web/ui.ts`) says `6.1s after the push ·
2.4s queued` and is the only place it is worded. The deploy's own log
   line stays measured from `startedAt` and says `after the deploy
started`; a deploy no push asked for — a redeploy someone pressed, a
   boot reconcile — is worded the same way and never claims a push.
   Where that time went is in the log too, step by step
   (`apps/timing.ts`): a `timing:` line before the process starts splits
   the wait for a permit (`turn`), reading the manifest, the checkout, the
   data and the setup, and one after it answers says how long the process
   took and when it first said anything. A restart brings every app's
   production back before any preview, and a production deploy waiting
   for a permit goes ahead of the previews waiting for one.
5. **A private app answers only to someone the forge vouches for.** An app's
   `access` is `public` or `private` (defaulting to the repository's
   visibility), and it is set apart from the repository's own: the code can
   be private while the app is public, or the other way round. A private
   environment sets no cookie of its own; a person arriving by its link is
   sent to the forge to sign in, which checks `canEnterApp` — the
   repository's writers, its crew, and the people the app names (its
   settings' **Who may enter**, `app_members` over MCP), never everyone who
   can read it — and
   returns them with a signed, short-lived grant for the page they wanted;
   the proxy asks the same question again on every request, so a grant
   stops working the moment its holder may no longer enter. Anyone else,
   and anything that is not a person navigating, gets the forge's own "not
   found". Guessing the hostname yields the same. Previews follow the app;
   the terminal stays its writers' and crew's. Making the repository public
   changes nobody's way in. A person the app names enters it and its
   previews and gets nothing else: no code of a private repository, no
   crew, no settings, no owner facts. What the app says about itself
   follows the same rule: its environments' state and errors (`envsFor`),
   its runs and their logs (`mayReadRuns`) and its run and serving events
   reach only those who may enter it.
   On any repository, public too, a run's **log** (the agent's
   transcript, a deploy's output) is read only by its writers and crew
   (`mayReadRunLog`); a stranger reads the run and its summary, not the
   log, on the page, the API and the live tails (#1075). Check runs share
   the rule: on a public repository the author of a pull from outside it
   reads a failed check's summary, not its output.
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
9. **Repository code runs in a cell of its own.** An app, its previews,
   its terminal, and every install, test and check step run inside
   bubblewrap (`apps/contain.ts`), the tool that already holds the crew's
   shell. In a cell the machine is read-only; the forge's data directory
   and home are empty; `/tmp` is the cell's own; the only writable places
   are its own checkout, its environment's data and a home kept beside it.
   It has a pid namespace of its own, so no other process's environment or
   memory is visible, and a network namespace of its own with loopback and
   nothing else: the way out is the forge's proxy (`apps/egress.ts`), which
   reaches the forge and the hosts `forge.json` declares in `egress` (on
   ports 80 and 443, unless an entry names its port), and refuses anything
   else with a 403 that names the host and port. A declared name that
   resolves to a private, loopback or link-local address (the cluster, the
   node's metadata service, another pod) is refused too. Every mount that
   may carry a secret is empty inside: `/run/secrets`, `/var/run/secrets`,
   and every tmpfs the machine mounts outside `/dev`, `/proc` and `/sys`
   (how Kubernetes mounts a secret or a service-account token) — and a pod
   that runs the forge should set `automountServiceAccountToken: false`
   all the same, since the forge never talks to the cluster. Inside
   Kubernetes a cell goes further and sees an allow-list of mounts: none
   of the pod's but the root, its own /dev, /proc and /sys,
   `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`, and the mounts the
   runtime and its tools live on — so a ConfigMap, hostPath, PVC or CSI
   volume mounted for the forge is empty inside. Elsewhere (a developer's
   machine, whose system is itself mounts: `/nix/store`, a home) the rule
   is the machine's mounts minus the secret-bearing ones above.
   `FORGE_CELL_MOUNTS=allow-list|deny-list` chooses either, and
   `FORGE_CELL_MOUNTS_KEEP` (`:`-separated) names a read-only system mount
   the allow-list must keep. Memory, CPU
   (averaged over 30 seconds) and disk are watched from outside; a cell
   over a limit is stopped, and the reason is the step's error or the
   app's last log line. Where the host cannot hold a cell (no bubblewrap,
   no user namespaces — macOS), the code runs as before and every deploy
   and check says so on its run page: "Uncontained", with the reason.

## The golden path

What a person sees, in order:

1. **New app.** A sentence about what it should do — that's the one thing
   that's required. The forge derives a name from it (shown, editable,
   before you submit) unless you set one yourself, creates the repository
   with a small working app in it, makes it an app, and starts production.
   Seconds later there is a URL. The sentence becomes the first issue,
   assigned to an agent on the crew, and the agent starts.
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
    "tty": "bun run src/tty.ts",
    "looks": ["/", "/board"]
  }
}
```

Only `run` is required, and even it defaults: a `package.json` with a `start`
script is enough. `install` defaults to `bun install` when a `package.json`
exists and to nothing otherwise; `test` defaults to nothing; `health` is the
path polled until it answers; `ready` is the number of seconds to wait for
that before the deploy fails; `tty` is the app's terminal interface (below);
`looks` names the pages worth a picture (below), and defaults to `["/"]`. The
file is read from the commit being deployed, never from the database — a
pull that changes how the app runs is previewed the way it will run.

`toolbar`, at the top level, is `true` unless you set it to `false`. The
forge adds one `<script>` tag to the HTML pages your app serves (before
`</body>`, or at the end): a small pill in the bottom-right corner, collapsed
until pressed, drawn in a shadow root so it never touches your styles. The
script comes from the forge's own origin, immutable-cached, with no inline
code; a `Content-Security-Policy` that forbids it just leaves the pill out.
Only `text/html` responses the app sends uncompressed with a `Content-Length`
(up to 4 MiB) are rewritten; JSON, images, compressed or chunked HTML and
`HEAD` requests pass through byte for byte. `"toolbar": false` keeps it out.

Two more fields say what the app's code may use (rule 9):

```json
{
  "egress": ["api.stripe.com", "*.cdn.example.com"],
  "app": { "run": "bun run src/server.ts", "limits": { "memory": 1024, "cpus": 1, "disk": 2048 } },
  "check": { "run": "bun test", "limits": { "memory": 4096 } }
}
```

`egress`, at the top level, is shared by the app and its check: exact host
names, or `*.` for every name below one, at most 32, each reachable on 80
and 443 — `db.example.com:5432` names one other port instead. Without it an app
reaches the forge and nothing else; install, test and check steps also
reach `registry.npmjs.org`. `limits` (MiB, cores, MiB) default to 512 MiB,
1 core and 1 GiB for an app and 2 GiB, 2 cores and 4 GiB for a step, and
are capped by the machine (`FORGE_CELL_MEMORY_MAX_MIB`, default 4096; the
number of cores; `FORGE_CELL_DISK_MAX_MIB`, default 16384). A cell's `/tmp`
holds at most 256 MiB.

Where the host cannot hold cells (or the crew's shell sandbox), the forge
runs uncontained and says so in one line: a boot warning, and, in the foot of
every page a site admin reads, `Reduced protection: apps (<reason>) runs
uncontained.` (`kernel/protection.ts`). A fully protected forge shows nothing.

A release that turns egress on must not break an app whose writers have
not declared what it uses yet, so the operator can start it reported:
`FORGE_CELLS_EGRESS=report` lets an undeclared public host through (on 80
and 443 only) and
counts it per repository (`<data>/egress/<repo id>.json`, under the
forge's data where no cell sees it), and the app's page tells its writers
which hosts it reached and the `egress` line to add. The default,
`enforce`, refuses them. Files, processes and private addresses are held
the same in both modes.

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
| `FORGE_API_URL`    | the forge's JSON API, `FORGE_URL` + `/api/v1`                            |
| `FORGE_TOKEN`      | a read-only token of the repository owner's, this process's alone        |

That last one is for the app to call the forge back on, not to run the forge
software itself — a shell that already has it set (a crew workspace does)
will make a locally-run forge refuse browser form posts as cross-site; see
`README.md`'s "Run it".

A terminal session (`tty`) gets the same variables plus `FORGE_APP_TTY=1`
and `FORGE_APP_USER`, the forge account at the keyboard or empty for a guest
— but no `FORGE_TOKEN`: a guest at the keyboard is not the owner.

### Live UI into the forge

`FORGE_TOKEN` is how a page an agent builds inside an app reads the forge
it runs on: `POST $FORGE_URL/mcp` (`now`, `map`, `apps`, `usage` — every tool that
does not write), the JSON API, and `GET $FORGE_URL/events`, the live stream
of everything the owner may see, with `Authorization: Bearer $FORGE_TOKEN`.
`examples/forge-live` is the worked example, and the acceptance test
(`test/apps-token.test.ts`) deploys it.

The token (`src/apps/token.ts`) is minted when a process starts — a deploy,
a crash restart, a wake — and revoked when that process stops for any
reason: replaced by the next deploy, asleep, stopped, torn down. It is
named `app:<slug>/<env>` among the owner's tokens and expires a day out;
the runtime's sweep pushes that forward while the process runs, so a forge
that dies without revoking it leaves a token that stops working by itself.

It is read-only on purpose. An app's pages are served to whoever its
`access` lets in, and a token that could act would let every one of them
act as the owner. Keep the token on the app's server — relay what a page
needs, never the token or the raw events — and keep a page that shows the
owner's forge behind `access: private` unless that is meant to be public.
Steering the crew (`say`, `tell`) stays the person's own act, on the forge.

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
bounded the same way. An app's own `test` still runs inside its deploy,
concurrently with `start` rather than before it; `check` is for a
repository that is not an app, or an app whose check is more than its
test. `install` defaults to `bun install` when the package
declares dependencies; `timeout` is seconds, twenty minutes by default.
A `check` that is present and wrong fails with the reason, so a commit is
never silently unchecked. A check under way when the forge restarts is
queued again, and the forge that carries on runs it from the start.

Checks share `FORGE_CHECKS_CONCURRENCY` slots (default `1`), and when one
frees, it goes to the most recently requested check waiting, not the one
queued longest — a fresh push is never stuck behind pulls that queued hours
earlier. The one exception is starvation: a check that has waited ten
minutes to start outranks a newer one regardless, so nothing waits forever.
A pull's status names how long its queued check has been waiting.

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

A variable has a **scope**: everywhere (`all`, the default), `production`
only, or `preview` only — the select beside the value, or `"scope"` in the
`PUT` body and `?scope=` on the `DELETE`. The same name may be set once in
each scope, and where two apply the narrower one wins: a test key for
previews, the live one for production, and neither process ever holds the
other's. Every preview is one scope, whichever pull it serves.

### Forge secrets

A credential the forge itself needs (a DNS token to spawn forges, a bucket
key for tofu state) is not an app's variable and never enters one. A forge
admin seals it under **Settings → Secrets**, or on an organization's page or
a repository's settings, or with `PUT /api/v1/secrets/:scope/:name`
(`{ "value", "ref" }`; `ref` is an org name or `owner/name`; scope is `forge`,
`org` or `repo`). Values are write-only; the list carries names, `updatedAt`
and `lastReadAt`. The only read path is `resolveSecrets` in
`core/secret_store.ts`: the narrowest scope wins, and each open appends a
`secret.read` event (actor, run, name, scope — never the value). Rows are
sealed under AAD `secret:<scope>:<name>`. Like every sealed row, they sit
beside the key in the data directory and so in a snapshot.

**A crew run's secrets.** An agent's brief, or an issue body written by someone
with write access, declares what a run may hold in front-matter at the top:

    ---
    secrets: CLOUDFLARE_API_TOKEN@api.cloudflare.com, TF_BUCKET_KEY
    ---

Only declared names are resolved (`crew/grant.ts`); malformed names and names
that would shadow the run's environment (`FORGE_*`, `GIT_*`, `PATH`, …) are
refused in the run's log. Values go into the run's env beside `FORGE_TOKEN`,
and `@host` widens the shell sandbox's egress for that run only. From the
moment they are opened the values are redacted (plain, base64, URL-encoded)
from the run log, the agent's last message and every event payload; before
the forge commits for the agent it scrubs them from the tree, and a branch
whose commits hold one is not pushed (`crew/leak.ts`). The names held are
recorded in `run_secret` and shown on the run page; the grant is dropped when
the run ends, and a sweep closes a crash's. A model that pushes by itself
cannot be stopped from pushing a value it transformed beyond those encodings.

A process reads its environment once, at start, so setting or removing a
variable redeploys what reads it, at its current commit, and nothing else:
a variable for everywhere redeploys production and every open preview, one
scoped to previews leaves production running as it was. The install and
test steps do not see them.

### The forge as an app of itself

The forge's own repository declares an app, so a forge can host the forge:
production runs `main`, and every pull gets a preview forge of its own —
the place to try a change that might not earn its keep, with the data it
would run against, and with a crew of its own to try it on. The manifest
is nothing special:

```json
"app": { "run": "bun run src/main.ts", "install": "", "health": "/healthz", "ready": 90 }
```

The forge knows when it is hosted: `FORGE_APP_URL` set means a forge put
it here, and it takes its address and its data directory from the host's
`FORGE_APP_*` rather than from `FORGE_URL` and `FORGE_DATA`, which name
the host. Hosted, the defaults change to what fits inside another forge —
no SSH listener (the host owns the port), one agent at a time, and its
apps' hostnames nested under its own: an app `cs` of the forge at
`lab--14--<domain>` answers at `cs--lab--14--<domain>`, and its previews at
`cs--3--lab--14--<domain>`. The host routes those by the tail of the label
— the part that names an app of _its_ own — and passes what stands in
front through in `Host`, untouched, for the guest to route. Anything set
explicitly still wins, so `FORGE_APPS=0` makes a hosted forge that serves
pages and git and nothing else.

A preview made with **copy** starts as a copy of the hosted forge — the
same accounts, repositories and crew, disposable — and, like any preview,
inherits the app's environment variables. That is how its crew signs in:
a `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) set on the app under
**Settings → App → Environment** reaches every forge it hosts, and no
other secret of the host does — an app's environment is only what the
section above lists, and its first sign-up is its admin, as on any fresh
forge. `install` is empty because the forge has no dependencies to fetch;
`ready` is generous because the first boot migrates.

## What a new app starts as

**New app** writes a small, complete app into the repository
(`src/apps/scaffold.ts`): notes behind a page, a JSON API, an MCP server
and a terminal, all over one set of actions, with no dependencies. What
the forge already does for every app (identity, the grant, preview data,
health polling, the terminal, the swap, sleep, the contract's wall) is not
repeated in it. What it adds is what an app owes its people on its own,
each proved by a suite of the app's own that runs on every deploy:

| guarantee          | where                                     | what holds it                                                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the door           | `src/security.ts`                         | rationing, same-origin on writes, and the contract asked before the body is read: whoever the table lets through a resource's `api` door for no row at all is refused there (401 a stranger, 403 anyone else); `/openapi.json` is shut to strangers when the table opens them nothing |
| the audit trail    | `src/audit.ts`, table `audit`             | every create, update and delete, and every refused one, as a row (who, resource, verb, row, when, let or not); `GET /api/audit` for admins, as the `audit` resource's cells say; a row that cannot be written is a log line, never a failed request                                   |
| the API, described | `src/openapi.ts`, `contract/openapi.json` | each API route declares its shape beside itself; `bun run contract:emit` writes the file, each operation names its contract cell (`x-contract`), the suite fails while the committed file is stale, and `GET /openapi.json` serves it                                                 |
| up or not          | `GET /healthz`                            | `{ ok, version, commit, env, uptime }`, and `forge.json`'s `health` points at it                                                                                                                                                                                                      |
| the look           | `design/tokens.json`, `src/tokens.ts`     | W3C design tokens, light and dark, compiled at boot to `/tokens.css`; `bun run lint:design` refuses a raw `#hex`/`rgb(`/`hsl(` outside the tokens and a `var(--…)` no token defines; every pair a person reads is held to 4.5:1 in both themes                                        |
| the open web       | `src/page.ts`, `src/routes.ts`            | description, Open Graph and a card on every page; `/robots.txt` (the API closed to crawlers, a preview closed entirely, and `X-Robots-Tag: noindex` off production); `/.well-known/security.txt` redirects to the forge's own                                                         |

The scaffold's `AGENTS.md` tells the crew to keep all of it: every change
returns through `audited`, every API route carries its description, no
colour is spelled out, and the door is never routed around.
`test/scaffold.test.ts` writes the scaffold out and runs its suite and its
two scripts, so a change to the scaffold that breaks one of these does
not land. The table the door reads knows two signed identities, `user`
and `admin`; a role such as a team's (`manage`) waits on the forge
signing one (see [CONTRACT.md](CONTRACT.md)).

## Who is there: identity from the forge

**Sign-in is OpenID Connect.** The scaffold's "Sign in" (`/signin`) is the
code flow with PKCE against `FORGE_URL` (see the last section). On first boot
it registers its own redirect address, `<FORGE_APP_URL>/signin/callback`, and
keeps the client id in `FORGE_APP_DATA/oidc-client.json`, so production and
each preview are separate clients. It verifies the `id_token` itself and keeps
a session in an HttpOnly cookie; a person signed in this way is a `user`. The
headers below remain only until a follow-up change retires them: once no app
reads `x-forge-identity` and `x-forge-signature`, the forge stops sending them
and `FORGE_APP_IDENTITY_KEY` goes with them (that change also settles where
`admin` comes from, which an `id_token` does not carry).

An app never writes sign-in. The forge tells it who is there, on every
request it proxies, in two headers:

- `x-forge-identity` — `<user id>|<username>|<role>|<expiry ms>`, where the
  role is `user` (a signed-in person who can see the app's repository) or
  `admin` (one who can write it);
- `x-forge-signature` — the HMAC-SHA256 of that exact string, base64url,
  under the app's identity key, which the forge hands the app as
  `FORGE_APP_IDENTITY_KEY` when it starts it (the same key for production
  and every preview of the app, a different key for every app, derived from
  the forge's own so nothing new is stored).

No headers means nobody the forge could name: a visitor to a public app who
never signed in. The forge drops any copy of these headers a client sends
before it speaks, so a verified signature is the only thing an app has to
trust — and it must verify: a constant-time compare of the signature and a
check that the expiry is in the future (`src/who.ts` in the template does
exactly this).

Behind the headers is the grant. A person who opens an app through the
forge — the app's link, or the app's own **Sign in** — is sent to
`/apps/open`, which vouches for them if they may enter the app (anyone,
for a public app; a writer, the crew or a person it names, for a private
one) and sends them
back with a signed grant in a cookie naming them (twelve hours,
HttpOnly, SameSite=Lax). The forge answers two paths on every app's host:
`/__forge/signin?to=<path>` starts that round trip, and
`/__forge/signout?to=<path>` drops the grant. A private app admits nobody
without a grant; a public app admits everyone, and names those who have one.
An app of a forge hosted here (a nested hostname) routes both paths through
to that forge, which speaks for its own apps.

A third path, `/__forge/report?from=<path>`, is for a public app of a public
repository: it sends anyone, with no account, to the repository's report
form (STANDARDS.md, "Reports from outside") with the page they came from,
and is answered without waking the app, since the app being down is the
usual reason to ask. Such an app's HTML responses, and the forge's own "not
running" page for it, carry `Link: </__forge/report>; rel="help"`, and the
template's footer links to it. A private app or repository offers none of
this.

What each of them may do is a table, not code: the app's `contract.json`,
decided by the forge's own evaluator carried into the app. See
[CONTRACT.md](CONTRACT.md).

## A terminal for every app

The forge's own port answers `ssh`, and the login name picks what opens:
any name opens the forge's terminal UI, and an app's slug opens **that
app's terminal** — `ssh -p 2222 notes@forge` runs the app's `tty` command
on a real pty, in the deployed checkout, with the environment's own
variables (`FORGE_APP_DATA` and the rest, plus `FORGE_APP_TTY=1` and
`FORGE_APP_USER`, the forge account at the keyboard or empty for a guest).
`notes--12@forge` is the preview of pull 12's. The key still decides who
you are: a private app's terminal answers only to a key the forge knows
that can write the repository, or the crew's; a public app's answers to
anyone, as its web page does. Resizes pass through; closing the connection sends the program
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

A forge needs a hostname to hand out for this — not every address it can be
reached at is one. Attach a slug to a bare IP address (`127.0.0.1`, the
default when nothing sets `FORGE_URL` or `FORGE_HOST`) and the result,
`notes.127.0.0.1`, is not a URL: WHATWG rejects a hostname whose last label
is all digits unless the whole thing parses as an IPv4 address. The forge
checks this once at boot, for the host it is about to hand out. A loopback
address falls back to `localhost` on its own — same as the paragraph above,
and it says so in the log. Reached any other way by IP, there is no host to
fall back to that would resolve anywhere but here, so apps are left off
rather than started to crash: set `FORGE_APP_DOMAIN` to a real hostname
(anything DNS resolves to this machine) to serve apps on a forge like that.

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

## Your own domain

An app can answer at a name you own — `app.example.com`, or an apex like
`example.com` — beside the hostname the forge gave it. Under **Settings →
App → Domains** an admin of the repository adds the name (or `POST
/api/v1/repos/:owner/:name/app/domains` with a `{ "host" }` body) and is
shown the two records to publish in the zone:

- a TXT record at `_forge-verify.<host>` whose value is `forge-verify=<token>`
  — the proof that whoever added the name holds it. The token is made for
  that one domain and is not a secret: it is published;
- a CNAME from `<host>` to the app's own hostname (`notes.forge.example`),
  which carries the traffic. An apex cannot carry a CNAME: use the DNS
  provider's ALIAS or ANAME record instead, or A and AAAA records with the
  address the forge is served at.

The forge checks when asked — **Check now** on the page, or `POST
…/app/domains/:host/check` — never on a timer. It looks the TXT record up;
the domain is verified when some record there is exactly the value shown.
Every check leaves one sentence a person can act on ("No TXT record at
`_forge-verify.app.example.com` yet.", "The TXT record is there but holds a
different value.", "Verified; app.example.com points at
notes.forge.example."), and when it was said. Verification is a proof of
control at one moment, like a certificate's: the first check that finds the
record verifies the domain, and a record tidied away later does not take a
live site down. Removing the domain is what stops the forge answering there.

Once verified, the forge serves the app at that host — production, at the
same port, through the same proxy, with the same grant — and production's
URL becomes `https://app.example.com`: every "Open the app" link, the app's
JSON `url`, and the `FORGE_APP_URL` its process starts with. The app itself
learns its new address at its next deploy, because a process reads its
environment once. Until a domain is verified the forge answers for itself
at that name, exactly as it does for any hostname it does not know; a name
that is nobody's proof serves nobody's app. The hostname the forge gave the
app keeps working beside the domain.

A private app's sign-in works on the new host as it does on the old: a
visitor arriving at `app.example.com` is sent to the forge, vouched for, and
sent back to `app.example.com/__forge/grant`, where the grant cookie is set
for that host. One host names one app's production; a second domain on the
same app is served too, and the oldest verified one is the URL.

Whatever fronts the forge must route the name to it. A wildcard certificate
covers `*.forge.example` and not `app.example.com`, so the proxy needs a
certificate per domain. With Caddy, `on_demand_tls` fetches one the first
time a name is asked for, and asks the forge first whether the name is
anyone's: `GET /__forge/domains/ask?domain=<host>` answers 200 for a
verified domain and 404 for anything else, so a stranger cannot make the
proxy fetch certificates for names that are not here (`docs/EXTRACT.md`
has the Caddyfile). A tunnel routes the host the way it routes the
wildcard. The forge itself speaks plain HTTP either way.

## A release does not drop a session

The forge is one process on one volume, and a release replaces it. The new
process comes up beside the old one and takes everything new once it is
ready; the old one drains: it starts no new crew runs and lets the ones in
flight finish and land (a run cut short is a person's money spent twice),
stops its apps and its checks, says so on `/readyz`, and keeps serving
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
value), `run` (repo, kind, issue, commit, state, summary, cost, timings —
`startedAt`, `servingAt`, `finishedAt`), `agent` (user, model, brief,
budget), and `issue.assignee_id`. The current deployment of each environment is in
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

A run's page is a transcript, drawn line by line as it is written: who
speaks in a column — the agent, the forge, _you_ — the tools the agent
reached for as quiet chips, the clock running and, at the end, what the run
cost in money and turns. The transcript keeps to its end until the reader
scrolls up, then offers the way back down. The stream numbers every line,
so a browser that reconnects hears only what followed; nothing on the page
reloads under a reader.

**Steering.** Under the transcript, a composer. A running agent hears what
is typed there as its next turn: the forge drives Claude Code over its
stream-json input and keeps the session open while a word is pending, so
_also add a test_ arrives after the step the agent is on, in the same
session, with everything it already knows. Enter sends. The words are kept
in the log as `you:` lines, and the same composer on a run that is over
puts them on the conversation instead, where the next run reads them. A
comment or review left on the issue or pull while the agent works reaches
it the same way, as its next turn, rather than queuing a second run behind
the first; only when nobody is listening does a follow-up run queue, and
one waiting is enough. _Stop_ sits beside _Send_ while the run goes.

Each agent's row on
the crew page carries the numbers that say how it is doing: runs and how
many landed, pulls a person merged, spend, and the mean cost, time and
turns of a run.

On a pull, the runs for the current head are its checks. A deploy run that
fails — install, build, or the app never answering — fails the check before
anything serves; the preview shows the log where it stopped. A deploy whose
app answers but whose `test` then fails is different: the preview keeps
serving that commit, but the run still fails the check, and the page says
in words that it is serving code whose tests failed. A push makes new runs;
older ones are history, not status.

### The look

When a deploy comes up green the forge takes a picture of it — every page
`app.looks` names, `/` alone when it names none — at a phone's width
(390×844), a laptop's (1280×800), and a thumb's (200×125, desktop's own
aspect, small), and keeps the pictures beside the commit they are of, so a
person judges a change from what it is rather than from what it says.
`app.looks` may name at most three pages: a browser start per picture per
width is the heaviest thing the forge does, and more is a manifest error
rather than a silent, slower deploy. The pull page shows the phone and
desktop pair under the checks, with the commit and a word when the head has
moved since; more than one page gets one group per page, each labelled by
its path, since a page that failed keeps its last good picture while another
moves on. The studio's ask row, the board's landed row, and an app's studio
head always show the home page's own picture, whatever else `app.looks`
names — the thumb, or (before it existed on that commit) the phone shot that
slot used to load, so nothing goes blank. Pictures are served at
`/:owner/:name/looks/<env>/<commit>/<kind>.png` for the home page, or
`/:owner/:name/looks/<env>/<commit>/<page>-<kind>.png` for another, with the
repository's own read access, cached by commit.

The phone and desktop pictures are what the repository's owner would see:
headless Chromium is pointed at the forge's own listener with the app's
hostname resolved to loopback, through the grant door, so the app renders for
a signed-in admin exactly as when the owner opens it — and they are its
writers' alone. The thumb is taken as nobody, for the tiles strangers see. A
public app on a public repository is the world's to see, so all three of its
pictures are taken as nobody, and a reader of its pulls sees the Look card
too; each row records who it was `taken_as` (#727, #738). It is taken as the page loads — what an
app draws after that is not in it — and one at a time, forge-wide, bounded
in time and memory. A look is best-effort: it never blocks a check or fails
a run; one that could not be taken is recorded with its reason, and the
page says "no picture" honestly. One look per environment and head; a
newer head replaces one still waiting; one that waited ten minutes is
dropped. The pictures live as long as the environment: a preview's go when
its pull closes. Files live under `<data>/looks/<app id>/<env>/`; rows in
`look`. The browser is `chromium` (or `chromium-browser`, `google-chrome`)
on `PATH`, `FORGE_CHROMIUM`, or the Mac's own; the image ships one. A forge
without one says so once at boot, and on every pull.
**A look a person attaches.** A person who can write the app (an agent
cannot; the crew's looks come from the preview) attaches a picture to an
open pull: `POST /api/v1/repos/:owner/:name/pulls/:number/looks` with JSON
`{width: "phone"|"desktop", says: "one line", image: "<base64 PNG or JPEG>"}`,
at most 5 MB, or the MCP `attach_look`. It is read as bytes (a PNG or JPEG
that parses, nothing else), kept under the preview's folder at the pull's
head, and shown in the Look card beside the crew's, to the writers only.
It stays when the head moves on and goes with the preview when the pull
closes.


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
  tail. Bounded by rule 7. A failure the crew reads as the place it ran —
  a timeout, a missing tool, a flaky runner — runs the check again once
  for that commit instead, and spends none of the pull's tries; a second
  red on the same commit is taken at face value, and what the pull is
  parked with says which of the two failed.

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

Each subscription keeps a _standing_ (`core/standing.ts`): where it is in
its 5-hour and weekly windows — started, resets, cap, used, remaining, in
US dollars of list price. When the provider turns a run away, the window
it named and its reset are kept as _read_; everything else is _inferred_
from the usage ledger — a window opens at the first run after the last one
closed, and the cap is what the crew had spent when the provider last
called the window full (a person's own use is not in the ledger, so it is
a floor). An operator keeps a share of every window for people
(Settings → Subscriptions, 0–90%); `crewRemaining` is what is left after
it. Both read on `GET /api/v1/repos/:owner/:name/usage` and the MCP
`usage` tool, under `standing`.

Across repositories, the _fleet graph_ (`GET /fleet/graph`) draws a
selection's spend and runs from the same ledger: the last 24 hours by UTC
hour and the last 14 days by UTC day, stacked per repository, with the
numbers as a table beside it. The selection is `?repo=owner/name`,
repeated; absent, it is every repository you can write that spent in the
last 14 days. A run counts in the bucket it ended in. Past eight
repositories the smallest spenders share one grey series, "N others".
The page redraws every 30 seconds while it is open, and at once on a
`forge:fleet-op` event, so an operation's effect shows within a minute.
The same numbers are `GET /fleet/graph.csv` and `GET /api/v1/fleet/graph`;
spend is the owner's fact, so a repository you cannot write is dropped
and counted with the names that do not exist, never told apart.

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
credentials (`~/.ssh`, `~/.aws`, and their kin). The crew probes once at
start whether the host can hold a run to that — bubblewrap, socat and a
user namespace it is allowed to make — and where it cannot, as in a
locked-down container, the sandbox is handed over switched off and every
run's log says so in one line, rather than warning on each command and
running anyway. The repository's own
`AGENTS.md` is read the way Claude Code always reads it, so a repository
can steer its crew without touching the forge.

The forge asks the host for one more binary than before: `claude`, found on
`PATH` or at `FORGE_CLAUDE`. Authentication is the operator's — an
`ANTHROPIC_API_KEY` or a `CLAUDE_CODE_OAUTH_TOKEN` in the forge's environment
is handed to the run, or the machine's own Claude Code login is used when
there is neither. When neither
works the crew page says so, in words, before anyone assigns anything.

### Asleep

A preview whose pull has had no push and no comment for three days is
stopped and shown as _asleep_ with when and why — its row, data and pictures
stay. It is not failed, and a restart leaves it stopped. Asking for it (a
request to its host, or **Wake it** on the change's page) deploys it again
on the ordinary deploy path. Production, and a pull with a run queued or
running on it, are never put to sleep this way. `FORGE_PREVIEW_IDLE_DAYS`
sets the age; `0` keeps every preview warm.

An environment nobody asks for does not keep a process. A preview that has
served no request for thirty minutes, or production for a day, is stopped
and marked _asleep_, its checkout kept whole; the next request through the
proxy starts it again — warm, without install or test, in about the time a
page takes — and waits for it rather than showing a closed door. The forge
coming back does the same: production starts warm from the checkout it kept,
and every preview comes back asleep until someone looks. A restart used to
mean thirty installs and test suites at once; now it means starting what
people are using.

Quiet is not the same as idle. Before it sleeps an environment the sweep
asks whether it is _busy_ (`apps/busy.ts`): a child process of the app's
still alive — a build, a crew run inside a hosted forge — or a websocket or
event stream the proxy holds open to it. A busy environment is left awake,
the app page and the Now card say _busy_ and why, and its deploy log says
it was kept awake. Busy buys one crew run's length past the idle window
(`FORGE_CREW_TIMEOUT_MIN`, 45 minutes by default) and no more, so an app
that keeps a child forever still rests.

### The meter

Awake and asleep are also what an app costs, so the runtime writes them
down (`core/meter.ts`). Every stretch an environment serves is one row in
`meter` — repository, environment, placement (`owned` or `cloud`), started,
ended — opened when a deploy or a wake starts serving (a redeploy keeps the
same row open) and closed when it sleeps, stops, crashes, is torn down or
the forge shuts down. Each sweep is a heartbeat on the open rows; a row the
last forge left open is closed at boot at its last heartbeat, never left
running. Once an hour the runtime samples each app's bytes — every
environment's `FORGE_APP_DATA` and its bare repository, files only, links
not followed (`apps/bytes.ts`) — into `storage`. `usageBetween` reads both
for a `[from, to)` range: awake seconds per app (by placement too) and
GB-hours, bytes × hours / 1e9, each sample standing for the hour after it
or until the next one.

### Subscriptions

One token in the environment is one account for the whole forge. An admin
with more than one — a personal plan and a work plan — adds each under
Settings → Subscriptions (a token from `claude setup-token`, or an API key;
sealed under the forge's key, never shown again) and grants it:

- on a repository's Settings → Crew, to everyone on the crew or to one agent;
- on an organization's page, for every repository under it.

A run takes its token from the nearest grant, whole: the repository's before
the owner's, the agent's own before the crew's. A grant whose accounts are
all resting holds the run until the first wakes rather than falling through
to a wider one, so a work repository never quietly spends the personal plan.
Two accounts on one grant take turns, the one used longest ago first. When
the provider turns an account away — a session's window, the week's limit —
that account rests until the time the provider names (now read from
`resets Sep 26 at 9pm (America/Chicago)` as well as `resets 7am (UTC)`), the
next account on the grant takes the run at once, and the pool page shows who
is resting and why, with a button to use it again sooner. Nothing granted
anywhere means the forge's own token, as before. Every run remembers the
account it spent.

### Prompts from Instagram

A repository's next tell can come from its audience. Under Settings →
Prompts an admin connects the Instagram account of the app — a game with
an account of its own, say — and once a day the forge reads the account's
latest Reel, takes its most-liked top-level comment, and tells the crew
exactly as a person would from the studio box: an issue is opened and
routed to a builder. The comment is the tell; the forge invents nothing.

What happens at the hour, every day, in UTC:

1. The token is refreshed when it is more than fifty days old (below).
2. The account's username is read once, the first time, and shown.
3. The latest Reel is found — the newest item Instagram marks `REELS`, or
   the newest video where it marks nothing.
4. Its top-level comments are read, at most four pages of fifty. The top
   comment is the one with the most likes; a tie goes to the earliest. A
   comment with no text does not count.
5. The crew is told, and the Reel is remembered as told.

The tell has one shape. Its first line is the issue's title, as with any
tell, and the rest is its body:

```
<the comment, as written>

From Instagram: the top comment (<n> likes) by @<username> on the Reel of <YYYY-MM-DD>. <permalink>
```

Nothing is told twice, and nothing is told early. A Reel already told is
skipped ("No new Reel since <date>; the last one was told as #<n>."), a
Reel with no comments yet is left for tomorrow and _not_ remembered as told
("The latest Reel has no comments yet."), and an account with no Reel says
so ("No Reel yet."). Every run leaves its sentence on the settings page, and
**Fetch now** runs the same routine at once, whatever the hour. A run that
meets an error ends in a sentence too, never a throw: Instagram's own words
in one line, or — for a token Instagram no longer accepts — "connect the
account again". A repository whose routine ran today does not run again
until tomorrow, and one whose forge was down at the hour catches up on the
next tick.

The token is a long-lived Instagram user token, which lives sixty days. It
is sealed under the forge's key, bound to its row, opened only for the run,
and never listed or shown again; the API's listing carries the account, the
hour, and what the last run said, and nothing else. When it is more than
fifty days old the forge refreshes it — Instagram allows a refresh once a
token is a day old — stores the new one sealed, and notes the time, so a
token pasted once stays good for as long as the account does. A token the
forge cannot open (a data directory restored under another key) asks to be
connected again, like everything else about a lost key.

The one-time steps at Meta, none of which needs App Review for an account
of your own:

1. Make the Instagram account a professional one (Business or Creator).
2. At developers.facebook.com, make a Meta app and add the **Instagram**
   product with Business Login for Instagram. No Facebook Page is needed.
3. Get a token for the account with the scopes `instagram_business_basic`
   and `instagram_business_manage_comments`.
4. Exchange it for a long-lived token, the one that lives sixty days.
5. Paste it under Settings → Prompts, choose the hour, and press Add — or
   `POST /api/v1/repos/:owner/:name/prompts` with
   `{ "kind": "instagram", "token": "…", "at": "15:00" }`.

`prompt.told` on the outbox names the source, the Reel, the comment and the
issue; it is for the repository's admins, like everything else about its
settings.

## Something that needs you reaches your phone

Under Settings → Profile a person may set one **notify URL**: an `https:`
address that takes a POST of plain text (an [ntfy](https://ntfy.sh) topic
does). When the forge's events change what asks them — a pull the crew
stopped on, a green pull waiting for a look, a repository at its ceiling —
one line and a link to the asks screen is posted there (`src/crew/notify.ts`).
A milestone the person watches says one line too, once, when it lands, with
a link to the milestone (`docs/PLANNING.md`); its progress never does.

- *New only.* What asks a person is read as that person, the way the asks
  panel reads it, so a private repository's titles never go to someone who
  cannot read it. An ask is told once; it is new again only after it went
  away and came back. A restart, or saving the URL, starts from what asks now.
- *Bounded.* Ten an hour per person. A failing endpoint pauses that person's
  notifications for a minute, doubling to an hour; what could not be sent is
  dropped, never retried or queued. Nothing blocks the event stream.
- *The URL is a secret* (a topic name is a password). It is `https:` only,
  without credentials, at most 200 characters, and refuses loopback, private,
  link-local, `.local`, `.internal` and bare hosts. The name is resolved and
  judged again at send time and redirects are not followed. It is kept in the
  user's settings, never logged, and the account page shows only its host.
- Not here yet: a health problem for an admin has no event to ride.

## Configuration

| variable                  | default                         | meaning                                           |
| ------------------------- | ------------------------------- | ------------------------------------------------- |
| `FORGE_APPS`              | `1`                             | `0` runs no apps and no crew                      |
| `FORGE_APP_DOMAIN`        | the host in `FORGE_URL`/`_HOST` | what app hostnames attach to (`example` or `--x`) |
| `FORGE_APPS_CONCURRENCY`  | `2`                             | deploys running their heavy steps at once         |
| `FORGE_PREVIEW_IDLE_DAYS` | `3`                             | days a pull may sit untouched before its preview sleeps; `0` = never |
| `FORGE_CREW_CONCURRENCY`  | `2`                             | agent runs at once (live: Settings → Capacity)    |
| `FORGE_CHECKS_CONCURRENCY` | `1`                            | checks at once (live: Settings → Capacity)        |
| `FORGE_CHECK_SHARDS`      | the machine's cores             | test shards per check (live: Settings → Capacity) |
| `FORGE_CELLS_EGRESS`      | `enforce`                       | `report` lets undeclared egress through on 80/443 (live: Settings → Capacity) |
| `FORGE_CREW_BUDGET_USD`   | `5`                             | spend per run unless the agent says otherwise     |
| `FORGE_CREW_TIMEOUT_MIN`  | `45`                            | wall-clock limit of one agent run                 |
| `FORGE_CREW_ALLOW_HOSTS`  | —                               | hosts an agent's shell may reach, comma-separated |
| `FORGE_CLAUDE`            | `claude` on `PATH`              | the Claude Code binary                            |
| `FORGE_CLAUDE_CONFIG_DIR` | Claude Code's own               | a `CLAUDE_CONFIG_DIR` for runs, when wanted       |
| `FORGE_CHROMIUM`          | `chromium` on `PATH`            | the browser the look is taken with                |
| `ANTHROPIC_API_KEY`       | —                               | handed to agent runs when set                     |
| `CLAUDE_CODE_OAUTH_TOKEN` | —                               | handed to agent runs when set                     |
| `TYPESAFE_API_KEY`        | —                               | TypeSafe's Jev answers fixed-choice decisions     |
| `TYPESAFE_MODEL`          | `jev-latest`                    | the TypeSafe model to ask                         |

The public URL apps and agents are told about the forge is `FORGE_URL` when
set, else `http://<FORGE_HOST>:<PORT>`; its scheme and port are what app
URLs are built with, so a forge behind TLS on a wildcard domain sets
`FORGE_URL=https://forge.example` and `FORGE_APP_DOMAIN=apps.example`.
Hosted by a forge (`FORGE_APP_URL` set), the address is `FORGE_APP_URL`,
the data directory `FORGE_APP_DATA`, and the defaults become
`FORGE_SSH_PORT=0`, `FORGE_CREW_CONCURRENCY=1` and
`FORGE_APP_DOMAIN=--<its own host>`.

Every limit an owner can hit (crew runs and checks at once, budget
ceilings, per-account caps, sign-in rates) is listed with its value and its
reason under **Settings → Limits** (`/admin/limits`, forge admin only),
declared in `settings/limits.ts` and read on every use.

Four of these are the forge's capacity and change while it runs: crew runs
at once, checks at once, shards per check, and the cells' egress mode. A
forge admin sets them under **Settings → Capacity**, through
`PUT /api/v1/admin/capacity/:key` (`{"value": "1"}`, `null` for the
default) or the `capacity` MCP tool; the next crew run, check or cell
honours the change, never a restart. The variable stays the boot default
until a value is set, and every change is listed on that page with who
made it, when, and from what to what (`core/capacity.ts`). The shard count
reaches a check's commands and an agent's shell as `FORGE_CHECK_SHARDS`,
from the setting, never from the forge's own environment.

### Boards: counting the forge's own tables

A site admin who is a person (never an agent, whatever its token's scope)
reads the forge's tables as counts through two routes; anyone else gets
403, a signed-out caller 401. `GET /api/v1/boards/sources` lists each
source with its `time` column and its columns' types (`boards/sources.ts`;
a column holding a secret or free text is never listed).
`POST /api/v1/boards/query` takes
`{source, from, to, filter, groupBy, aggregate, column}`:

- `source`: a name from the list; `aggregate`: `count`, `sum`, `avg` or `max`
  (the last three need a numeric `column`).
- `from` (inclusive) and `to` (exclusive): dates, applied to the source's time column.
- `filter`: up to 16 of `{column, op, value}`, `op` one of `eq ne lt lte gt gte`.
- `groupBy`: a column, or `{"bucket": "minute" | "hour" | "day"}`.

It answers `{"rows": [{"group", "value"}]}`, at most 1000 rows. A query the
module refuses is `400 bad_query` with its message; a body that is not JSON
is `400 bad_json`; a body over the cap is `413 too_large`.

    POST /api/v1/boards/query
    {"source": "runs", "aggregate": "count", "groupBy": "state"}
    -> {"rows": [{"group": "failed", "value": 1}, {"group": "ok", "value": 7}]}

## What is deliberately not here

Containers. A cell (rule 9) is namespaces and a watch, not an image: an
app runs the machine's own `bun` and tools, read-only, and its limits are
enforced by stopping it, not by throttling it — a container cannot create
the cgroups that would throttle. TLS
termination and an approve-and-land gate are additions of the same kind:
the shapes above hold, and a new column or listener carries each of them —
as one column carried a domain of the app's own.

## The `service` kind

`app.kind: "service"` in `forge.json` declares a long-running app that is not
an HTTP child: `ports` (TCP, 1024–65535, required), `always_on` (true; false is
refused), `placement` (`"metal"` or `"cloud"`, optional) and `volumes`
(`{ "path": "world", "sync": 300 }`, a relative path under the app's data and a
sync cadence in seconds, 10–86400). `src/apps/service.ts` validates it; the
manifest carries it as `service`, `null` for a web app. Running it, exposing
the ports and syncing volumes are not built yet (issue #391).

## The access log

The forge keeps one compact JSON line per request that is not a static asset
(or `/healthz`) under `<data>/access/access-YYYY-MM-DD.log`: time, host,
method, path without its query string (secret-looking segments blanked),
status, duration, user agent (200 characters), whether a credential came with
it, and a hash of the client address keyed with the data directory's secret
and the day. Lines are queued in memory and appended in one write a second (or per 200 lines), so a request pays for no disk write. No token, cookie or query string is ever written. Files go after
14 days, a day's file stops at 4 MB and the directory at 32 MB, oldest first.
Nothing serves the files. A forge admin reads the last day's non-browser
requests to public paths at Settings → Access, or with the `access` MCP tool
(`since`, `ua`, `path`; write-scope token).

## The forge as an OpenID Connect provider

Discovery is at `/.well-known/openid-configuration`. Register a client at
`/oauth/register`, send a person to `/oauth/authorize` with `scope=openid`
(optionally `profile email`), a `nonce`, and a PKCE S256 challenge. The
`/oauth/token` answer carries an `id_token` (ES256) beside the ordinary
ro/rw access token — the same grant, not a second credential. Present that
access token to `/oauth/userinfo` for the claims. `/oauth/jwks` publishes the
current signing key and the previous one; keys rotate every 30 days and live
in the database, never in the repository.
