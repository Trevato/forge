# forge — architecture

A software forge: git hosting, code review, issues, and automation, built as one
fast process you can read in an afternoon and mold by hand. Forgejo is the
reference point for _what_ a forge should feel like — this is a distillation of
that feeling onto a foundation sized for one human.

## Principles

1. **The repository holds truth.** Git is the durable log. Application state
   that can be derived from git is derived from git; the database is an index,
   and it self-heals from git on boot. No state lives only in memory.
2. **One process, one file of state.** A single Bun process serves git, web,
   and API. SQLite is the only database. Everything a forge instance _is_ lives
   in one data directory you can tar up and move.
3. **Zero runtime dependencies.** The `package.json` dependency list is empty
   and stays empty. Anything worth having is worth writing: the Result type,
   the router, the templates, the design system, the markdown renderer. Take a
   20-line utility as a 20-line file, never as a package.
4. **Real git, thin wrapper.** Never reimplement pack negotiation, diff, blame,
   or merge. Spawn the `git` binary; be a careful plumber of bytes. Correctness
   comes from git itself, speed from long-lived batch processes and immutable
   caching, safety from strict argument hygiene.
5. **Automation is a first-class citizen.** Every state change is reachable by
   API with a scoped token, observable as a durable event, and auditable after
   the fact. An AI crew — or a shell script — is just another user with
   narrower credentials. "Forgejo is my harness" is the spec.
6. **Events are an outbox, not a broadcast.** Webhooks are fast but lossy;
   sweeps are slow but complete. Every event is a durable row first; delivery
   is retried; consumers reconcile. Nothing important rides on a fire-and-forget.
7. **Sovereignty by construction.** Your data is yours: one directory, one
   SQLite file, bare repos in plain layout, export at any time. Credentials are
   scoped narrowly (per-repo, per-run) and secrets are write-only.
8. **Mobile is not a viewport, it's a use case.** Every screen is designed
   thumb-first. Capturing an idea from a phone in the redwoods is the bar.
9. **Protections are mechanical, not policy.** Branch protection, token scopes,
   and merge gates are enforced in code paths, verified by tests that prove the
   bypass is impossible — never by convention.

## Stack: Bun + TypeScript

- **Runtime**: Bun. `Bun.serve` (streaming HTTP), `Bun.spawn` (streaming
  subprocess stdio — the crux of a git server), `bun:sqlite` (built-in,
  synchronous), `Bun.password` (argon2), WebCrypto, built-in gzip. One runtime
  covers every system need without a single package.
- **Language**: TypeScript, strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. Types are the documentation.
- **Deploy**: `bun run src/main.ts` in dev; `bun build --compile` produces a
  single native binary for release. The only system requirement is `git`.

Why not Go: Go's advantages (static binary, subprocess plumbing prior art) are
real, but Forgejo already exists as the Go forge. The differentiators here —
a Linear-grade interactive UI, a codebase in the author's molding language,
end-to-end one mental model — all point at TypeScript. Why not Rust: gitoxide
still can't own the write path, so Rust would shell out to git anyway while
tripling the cognitive cost.

## System shape

```
src/
  main.ts            boot: open db, ensure dirs, mount servers, start workers
  kernel/            zero-dep primitives: result, error, id, log, db
  git/               bare repos, smart HTTP + SSH, batch readers, hooks, guards
  core/              domain: users, sessions, tokens, repos, issues, pulls, events
  actions/           every mutation as one function: authorize, mutate, record
  http/              router, auth resolution, response shapes, the JSON API
  design/            the theme registry both surfaces render
  origins/           other forges behind one Provider: discovery, adapters,
                     OAuth, mirroring, incremental sync, push-through
  web/               SSR: html tag, icons, ui (components), chrome, layout,
                     client, style/ (base + components + content), pages/
  ssh/               the SSH server: transport, userauth, channels
  tui/               the terminal UI: runtime, widgets, screens, the front door
  test/              bun test — protocol-level and adversarial
```

`core/` is pure data: functions over the database and the bare repos that
neither authorize nor announce. `actions/` is where a mutation becomes a
platform event — each action takes the app and an actor, checks access with
the same three tiers everywhere (a repo you can't read is `not_found`, one
you can't write is `forbidden`, an admin surface you don't own is hidden),
performs the core mutation, and appends the event. The JSON API, the web
forms, and the terminal UI are adapters over the same actions, so a new
surface inherits every gate and every event by construction. Adapters keep
only what is genuinely theirs: token scope floors, cookie CSRF, response
shapes.

Modules follow the style distilled from better-auth / ai-sdk / better-result:
one concept per file named after the concept; shallow feature folders; plain
options objects with `@default` JSDoc; composition over inheritance; barrels
curate, never implement.

## Error model (two-tier)

- **Expected failures** return `Result<T, E>` — a plain discriminated union
  (`kernel/result.ts`, ~100 lines, no classes). If a caller can branch on it,
  it's in the signature.
- **Defects** throw `ForgeError` (one base class, `Symbol.for` cross-realm
  marker, `code` field). A thrown error means a bug, and it is loud.
- Every fire-and-forget async path is wrapped — an unhandled rejection must be
  structurally impossible, because in a single process it kills the forge.
  (Lesson paid for in full by open-platform-ts.)
- Unsafe casts carry `// SAFETY:` receipts.

## The git layer

- **Storage**: bare repos at `data/repos/<owner>/<name>.git`, standard layout,
  no working trees. `git maintenance` scheduled by a background worker.
  Forks use `objects/info/alternates` with an explicit detach path before
  parent deletion.
- **Serving (smart HTTP v2)**: `GET /:owner/:repo/info/refs?service=…` and
  `POST /:owner/:repo/git-{upload,receive}-pack` wrap
  `git {upload,receive}-pack --stateless-rpc`, piping request body → stdin and
  stdout → response stream. Handles `Content-Encoding: gzip` request bodies,
  forwards `Git-Protocol: version=2` into `GIT_PROTOCOL`, sets exact
  `application/x-git-*` content types, `Cache-Control: no-cache`, and the
  empty-repo advertisement case. Auth: HTTP Basic with username + personal
  access token over TLS; 401 + `WWW-Authenticate` challenge.
- **Serving (SSH)**: the same pipe without the request framing. A client runs
  `git-upload-pack '/owner/repo.git'` on an exec channel and speaks the
  _stateful_ protocol down it — no `--stateless-rpc`, no round-trip to bound
  the transfer, so writes back to the peer are paced by `SshSession.drain()`
  (a clone's pack outruns the channel window otherwise). `git/smart-ssh.ts`
  parses the command and plumbs bytes; the access decision lives with the
  caller, exactly as it does for HTTP.
- **Reads for the UI**: a small pool of long-lived `git cat-file --batch` /
  `--batch-check` processes per hot repo for object access;
  `for-each-ref` / `rev-list` / `diff` / `blame --porcelain` spawned per
  request where correctness demands real git. Blob/tree/diff renders are
  cached by SHA — immutable, so the cache never invalidates.
- **Writes from the app** (merges, ref updates): `git update-ref`,
  `merge-tree`/`commit-tree` plumbing in the bare repo — no temp clones on hot
  paths. PR refs live at `refs/pull/<n>/head` (and `/merge` for the test
  merge), written by the app, excluded from default fetch.
- **Hooks**: bare repos get pre-receive / update / post-receive stubs that exec
  back into the forge process over a localhost unix socket. pre-receive
  enforces protected branches against quarantined objects; post-receive
  appends durable rows to the events table and returns immediately. A push is
  never blocked on network I/O.
- **Hygiene**: deterministic git env (`GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, explicit
  `GIT_PROTOCOL` only); every ref/path argument validated (no `-` prefix, no
  `..`, no absolute paths); wall-clock timeouts with process kill on every
  spawn; `--` separators everywhere git accepts them.

## Data & state model

SQLite (`bun:sqlite`), WAL mode, foreign keys on, numbered migrations tracked
in `user_version`. The schema is deliberately small — tables earn their place:

- `user` (humans and bots; bots are just users with narrower tokens)
- `session` (cookie auth for the web)
- `token` (PATs: hashed, scoped — `repo:rw`, `repo:ro`, per-repo grants)
- `repo` (owner, name, visibility, default branch, protection rules)
- `issue` / `pull` / `comment` / `label` (pulls reference PR refs in git;
  the diff itself is never stored — git holds it)
- `event` (append-only outbox: pushes, state transitions, deliveries)
- `webhook` (subscriptions + delivery state with retry bookkeeping)
- `origin` / `origin_repo` / `origin_cursor` / `origin_app` / `oauth_flow`
  (connected accounts on other forges, and the connects in flight)

State transitions use compare-and-swap (`UPDATE … WHERE state = ?`), and every
transition writes its event row in the same transaction. On boot, a
reconciliation sweep repairs the index from git (a merged branch whose pull row
says "open" gets healed from the ref state, not trusted).

**The one exception to "the database is derived."** A connected origin's
access token is third-party state: it cannot be rebuilt from the bare repos,
from the event log, or from anything else this forge holds. It is rebuildable
only by the human re-authorizing with the other forge. That is precisely why
it is the only thing here encrypted at rest — AES-256-GCM under
`<data>/secret.key`, bound to its own row id — why no API route returns it in
any form, and why disconnecting destroys it rather than tombstoning it. Lose
the key file and you lose the tokens; you lose nothing else, and reconnecting
costs a click. Every other row in the database is still reconstructible from
git or from the origin, which is the same rule one level out: for a mirrored
repo, _the origin_ is truth and our rows are its index.

Two lessons Forgejo is still paying for, designed in up front:

- **Merge results stay reachable forever.** Merging a pull writes a durable
  `refs/pull/<n>/merged` ref in the same operation — a merged commit can never
  become unreachable through base-branch deletion plus gc (Forgejo #30972).
- **Review comments anchor to content, not coordinates.** A comment stores the
  blob line _content hash_ alongside file/line, so a force-push either
  re-anchors it exactly or marks it outdated explicitly — never silently lands
  it on the wrong line (Forgejo #21113).
- **A review verdict anchors to a commit.** An approval says "of _this_
  code", so `review` stores the `commit_oid` it was passed on and the merge
  gate counts only verdicts on the current head. A push therefore dismisses a
  stale approval by construction rather than by a background job somebody has
  to remember to write — and there is no setting to get wrong, because there
  is nothing to configure.

## The web

- **SSR from tagged template literals**: an `html` tag that auto-escapes
  interpolations (opt-out is explicit and greppable). Components are functions
  returning safe strings. No hydration framework — pages are fast HTML with
  surgical vanilla JS: URL-as-state (the nuqs pattern, ~15 lines), SSE for
  live updates, `data-*` attributes as the style/behavior hooks.
- **Design system**: a flat namespace of CSS custom properties is the entire
  theming machinery — every color (surfaces, semantics, diff tints, syntax
  tokens) is a variable, so a theme is a data table in `design/themes.ts`, not
  code. Six premade themes ship (three light, three dark); "system" follows
  the OS. The switcher is a plain form POST with a cookie — script only makes
  it instant. shadcn's essence without Tailwind: tokens, radii, spacing scale,
  semantic colors.
- **A security floor at the boundary, not per responder**: one wrapper around
  everything the forge answers for itself (`securityFloor`, `http/respond.ts`)
  puts `nosniff` and `referrer-policy: same-origin` on every response, and an
  inert `default-src 'none'` CSP on every non-document one — JSON, CSS,
  redirects. A page keeps the nonce'd policy it writes for itself, and an
  app's proxied response is carried untouched: its headers are its own.
- **Mobile-first**: layouts compose from a single column up; touch targets
  ≥44px; the fast paths (open issue, comment, review a diff, merge) are
  designed on a phone frame first and enhanced for desktop.

## The SSH transport

One port answers two things. `ssh forge.example` opens the terminal UI;
`git clone ssh://forge.example/owner/repo.git` runs git on an exec channel.
The server (`ssh/`) is ours — transport, userauth and channels, zero
dependencies, `session` channels only (no forwarding, no X11, no subsystems:
every other channel type is attack surface).

**A key is an identity, not a permit.** `authorize` admits every well-formed
key, and what the key _is_ decides what the session can do:

- a key registered to an account (`user_key.fingerprint`) → that user, with
  `last_used_at` touched;
- any other key → a **guest**, who browses public repos exactly as an
  anonymous web visitor does.

A guest becomes someone by signing in: username and password verified with the
same `verifyPassword` the web uses, then the presenting key is registered to
that account through the `addSshKey` action. The connection is that user from
that moment on — no reconnect — and the next connection needs no password. On a
forge with no accounts at all, the same screen creates the first one (which is
the admin), so a fresh forge is usable from a terminal alone.

There is no impersonation path. A session acts as the account its key maps to
and nothing else; the login name in `git@host` is decorative. The local dev
runner (`tui/main.ts --user alice`) is the one place an account can be chosen
by name, it runs over stdio, and it is not reachable over SSH.

Git over SSH enforces the HTTP matrix, function for function: `canRead` for
upload-pack (guests included), a signed-in `canWrite` for receive-pack,
push-to-create for a writer pushing to a repo that does not exist yet, and
`hookEnv` carrying the actor so pre-receive protection and post-receive events
fire identically to a push over HTTPS. A repo you cannot see is "not found" —
the same conflation as everywhere else.

## The terminal UI

`ssh forge.example` is a full-control client, not a status page: browse,
review, comment, label, merge, configure, and administer. It is built on the
runtime in `tui/`, whose one architectural rule is the `Terminal` boundary —
`write` / `onInput` / `size` / `onResize` / `onClose` / `close` and the `TERM`
the client announced. Everything above that line is pure, which is what lets
one runtime serve a local stdio session, an SSH channel, and a headless test
with no branch anywhere.

- **The loop** is a screen stack with a dirty flag and a 16ms frame tick. Not
  Elm: each stack entry owns an `AbortController` that `pop()` aborts, so
  cancellation costs one line and nothing lands on a dead screen. A screen's
  bus subscription is released by that same signal — popping is what
  unsubscribes.
- **Rendering** is a cell buffer diffed against the previous frame, emitting
  the minimum inside a synchronized-output pair. The theme's background is
  painted across the whole screen (terminal.shop's rule): a TUI that lets the
  user's own background show through looks like six half-themes.
- **The design system is shared, not parallel.** `design/themes.ts` is the one
  palette, `web/highlight.ts` the one tokenizer, `web/worddiff.ts` the one
  intra-line diff — so a "danger" badge, a merged pill and a changed
  substring mean and look the same in both surfaces by construction.
- **Screens are adapters over actions.** Every mutation a screen performs is
  an `actions/` call with the resolved user as the actor; `grep bus.append
src/tui` finds nothing. The access helpers are the web's, so the answer to
  "can this session see it" is computed in one place for all three surfaces —
  including the command palette, where resolving `owner/name` runs `canRead`
  before it opens anything.
- **Failure is bounded.** A load rejection becomes a toast; a render throw
  becomes one red line; an input handler throw ends _that session_ and leaves
  the process serving. All three are tested.

## The local client

`src/cli/` and `src/tui/local/` are the half of the forge that runs on a
laptop. The workbench says which repositories you want (pins); the client
keeps them cloned under `<root>/<host>/<owner>/<name>`, keeps them fetched,
and reports. The server never learns anything about local state, which is why
the client can be wrong about the network and still be useful.

Four decisions carry it.

- **The filesystem is the index**, exactly as git is the index on the server.
  There is no local database of "your repos": a depth-limited walk finds them,
  stopping at the first work tree it meets. A registry would be a second
  source of truth that goes stale the first time someone moves a directory —
  the same instinct as `core/reconcile.ts`, applied to a disk we do not own.
  The path is the primary key, so two forges with a `docs` repo coexist.
- **The client's git is not the server's git.** `git/env.ts` scrubs `HOME` and
  the global config because a forge process must never inherit an operator's
  settings; `git/local.ts` does the opposite, because this is the user's own
  checkout and their `user.email`, credential helper, SSH agent and signing
  key all have to apply. It pins exactly three variables:
  `GIT_TERMINAL_PROMPT=0` (a TUI cannot answer a prompt), `GIT_OPTIONAL_LOCKS=0`
  (status is polled), and `LC_ALL=C` (the output we parse is the output git
  documents). Diff flags additionally override `diff.external` and
  `diff.noprefix`, both of which would silently corrupt a patch we are about
  to hand back to `git apply`.
- **Nothing is destructive by default.** `sync` fetches and reports; it never
  merges, rebases, resets or checks out. `--ff` is the single exception, and
  it acts only when the tree is clean, nothing is ahead, no sequencer
  operation is in flight, and `merge-base --is-ancestor` has proved the move
  cannot lose a commit. `--watch` notifies only on a _transition_ — new
  commits behind, a repo newly pinned, a fetch that started failing — because
  a notifier that fires every tick is a notifier that gets muted.
- **The secret never enters argv or a remote URL.** HTTPS clones carry the
  token through `GIT_CONFIG_COUNT`/`KEY`/`VALUE` as an `http.extraHeader`, the
  same channel the server uses for origin credentials; SSH is preferred when
  the user has a key, so their agent does the work and no token exists to
  leak. `git remote -v` on a synced repo prints a plain URL.

The local screens are the forge's own runtime, not a second one: the same
`App`, `Screen`, widgets, themes and key conventions, with a work tree
underneath instead of a database. Hunk staging follows lazygit and tig — parse
the `-U3` diff, rebuild the one hunk as text with a recomputed `@@` header,
pipe it to `git apply [--cached] [-R]`, and _re-read the diff afterwards_,
because the line numbers have genuinely moved. `-U0` with `--unidiff-zero` is
the road not taken: it works, but it removes the placement check that makes a
wrong header fail loudly instead of silently corrupting a file.

The log graph is computed here rather than taken from `git log --graph`, whose
art is interleaved with the format output by contract — unparseable, and
impossible to re-lay-out for a narrow pane. `--parents` plus forty lines of
lane assignment renders correctly at any width, in the theme's own colours.

## Concurrency invariants (day one, not hardening)

Paid-for lessons from open-platform-ts, designed in structurally:

1. Every work-claim is a CAS; double-pick is impossible by construction.
2. Every fire-and-forget has a `.catch`; the event loop never sees a rejection.
3. Ordering: git state becomes durable before the index row that references
   it; events fire only after the caller's bookkeeping is durable.
4. The events table is the one queue; consumers are idempotent; a sweep
   reconciles anything a notification missed.
5. Config reloads fail closed — a bad config degrades to the last good one,
   never a dead process.

## The diff viewer

The centerpiece of code review, built from the distilled state of the art:

- **Highlight the whole file, then map onto the diff.** Syntax highlighting
  runs over the full old and new blobs independently, and the tokens are mapped
  onto diff rows by line number — never per-diff-line, which breaks multi-line
  comments and strings (Forgejo #33358). The tokenizer is a stateful per-line
  scanner (`web/highlight.ts`) that carries block-comment / multiline-string
  state across lines; it is lossless and bounded.
- **Two composed layers.** Syntax owns text color; the diff owns background and
  underline. `composeLine` merges a line's token classes and its per-character
  word-diff change mask into one span per run — so a changed number inside a
  modified line is both `tok-number` and `wd`, without either layer dictating
  the other's boundaries.
- **Intra-line word diff** via a bounded token LCS (`web/worddiff.ts`), shown as
  underline plus a saturated background — change is never signalled by hue alone.
- **Mobile-first unified view.** No side-by-side; nobody has made it work on a
  phone. Files collapse natively (`<details>`), windowing is pure CSS
  (`content-visibility`), the `+`/`-` marker is a `::before` so copy skips it,
  and files over ~5000 changed lines show a stub instead of rendering.

## Review states, and the gate they open

Code review has two units and they are not the same thing. A **line comment**
is anchored to a row of a diff (`comment`, `kind='review'`, with the content
hash above). A **verdict** — `approved`, `changes_requested`, `commented` —
is anchored to a commit, and it is what decides whether a change may land.
They are separate tables because they answer separate questions, and because
the merge gate has to be able to ask "is there an approval _of this head_",
which only a row carrying a commit id can answer.

Three rules, each mechanical rather than advisory, each with an adversarial
test behind it (`test/reviews-states.test.ts`):

- **A verdict with authority is a writer's.** Anyone who can read the repo
  may leave a `commented` review; approving or requesting changes takes write
  access. Otherwise "require an approval" would be satisfiable by any account
  that could see the repository.
- **You cannot approve your own change.** Requiring a review that the author
  can supply is not requiring a review.
- **Only the current head counts.** `reviewSummary` reads the latest verdict
  per reviewer and ignores any passed on an older commit. A request for
  changes on the head blocks a merge regardless of `require_review`; one on an
  older head does not, because it was about code that is no longer proposed.

`repo.require_review` turns the approval requirement on. The gate lives
inside `mergePull` (`core/pulls.ts`), reading the live head — a check
computed earlier by a caller and handed down is a check that can be skipped —
and refuses with `review_required`. `pullStatus` exposes the same numbers as
`reviews: { approved, changesRequested, required, mergeable }`, so a client
can render the state of play without guessing at it, and `null` when the
caller did not pass the gate context, because a permissive default is how a
protection quietly stops protecting.

Resolution hangs off the **thread** — every review comment sharing one
anchor — rather than off any single comment, because "settled" is a property
of a conversation. The thread's name is `anchorId(path, side, line)`, a short
digest, since the key itself carries a NUL and a path and belongs in no URL.
A writer or anyone who spoke in the thread may resolve it.

On a mirrored repo none of this is ours to decide: the verdict is submitted
at the origin under the connecting account's credential and imported back,
and everyone else's verdicts arrive on the next sync. `docs/ORIGINS.md` has
the dialect details, including the one that bites — GitHub takes the verb
`APPROVE` and answers with the noun `APPROVED`, and Forgejo takes the noun.

## Apps, runs, and the crew

`docs/APPS.md` is the contract; this is why it is shaped as it is.

An **app** is a repository that runs, on the forge's own port, by `Host`:
`<slug>.<domain>` is production (the default branch), `<slug>--<n>.<domain>`
the preview of pull `n`. The runtime (`apps/runtime.ts`) holds every
environment in memory and rebuilds them all on boot from the default branch
and the open pulls — a process is not state, and the same instinct that
makes `core/reconcile.ts` rebuild the index from git makes a restart the
recovery path rather than a special case. The app row holds what git cannot
say (slug, access, the preview-data policy); how the app runs is
`forge.json` at the deployed commit, read from the tree and never cached in
a row, so a pull that changes how the app starts is previewed as it will
run.

Three decisions carry the previews. **A preview lives exactly as long as
its pull is open**, and its data directory is created when the pull opens
and removed when it closes — there is no orphan state to garbage-collect
because the set of previews _is_ the set of open pulls. **Preview data is a
copy of production's, never a view of it**: `cpSync` with `FICLONE_FORCE`
clones blocks on APFS/XFS/btrfs and falls back to a byte copy elsewhere,
after every SQLite database under the directory has been checkpointed (the
pair `db` + `db-wal` copied mid-write would be two moments stitched
together). And **a failed deploy leaves the previous deployment serving**:
the new process must answer on its health path before the proxy switches
to it, so a broken push never takes production down.

A **run** is the durable record of work on a commit — a deploy, or an agent
working an issue — with a log file the surfaces tail live and a row claimed
`queued` → `running` by compare-and-swap. A deploy run _is_ the check on a
pull; with `require_checks` on, `mergePull` reads the head's latest deploy
run inside the merge, exactly as it reads the review verdict, and refuses
`checks_required`. There is no separate checks table to drift from the
runs that produced it.

The **crew** is agents as users. An agent is a user with `is_agent` set (a
flag beside `kind`, because `kind`'s CHECK cannot be widened without
rebuilding `user` under every table that references it, and `toUser` reads
it as `kind: "agent"` so nothing above the row knows): no password (an empty
hash that no verifier accepts), no session, and one grant — `repo_crew`,
read and write, never admin. Its credential is a token minted for a run
with an expiry and deleted when the run ends; `verifyToken` checks the
expiry on every use so a late sweep is never a late-working token. Two
refusals make the guardrail mechanical: the pre-receive hook refuses an
agent's push to the default branch whether or not it is protected, and
`mergePull` refuses an agent actor. Everything the agent can do, it does
through a pull a person merges.

Work reaches an agent off the outbox with a sweep behind it, like every
other consumer: an assignment starts a run; a person's comment, verdict, or
line comment on the agent's pull starts a follow-up that resumes the same
Claude Code session in the same clone; a failed deploy starts a bounded
follow-up. The runner does the bookkeeping the agent should never have to
get right — it pushes what was committed, opens the pull with the agent's
last message as the description, or updates the one that exists — so the
golden path is a property of the harness, not of the prompt. The prompt
still writes it down (`crew/brief.ts`), because prompting the golden path
and enforcing its edges are both cheaper than recovering from a detour.

Claude Code runs as a child process the way git does — a binary on the
host, spawned with an explicit environment (`childEnv`: path, home, the
operator's user, a locale; never the forge's own variables), file tools
confined to the clone, permissions passed as settings, no prompts, a spend
budget, a deadline. Containment is the forge's, not the agent's; the agent
is trusted to work, and the forge is built so that trust costs at most one
run.

## The forge's standing

`GET /api/v1/health` (`kernel/vitals.ts`) answers a site admin, by session or
any token scope, with `{ ok, needs, disk, memory, queue, stuck, apps, at }`;
everyone else gets a 404. `needs` is one sentence per thing off: disk under
10% free on the `FORGE_DATA` volume, a run running with a lapsed lease (or
past six hours), a queue whose oldest run has waited over thirty minutes.
It is a fixed handful of queries however many runs and apps exist, measured
per request and never cached. `/healthz` stays the orchestrator's answer.

## Search, and where semantic search would go

Search (`core/search.ts`, `actions/search.ts`, `GET /api/v1/search`) holds no
index of its own. Repos and conversations are already indexed rows; code is
answered by `git grep` against the object store, which _is_ the truth. Every
list is capped and every subprocess has a deadline, so a one-character query
costs the same order of work as a precise one — the palette is a hot path once
agents outnumber people. Cross-repo reach comes from what is already cached:
the origins' picker rows answer "is it on another forge?" without spending a
request, and only `live=1` asks an origin's own issue search, inside one budget.

Semantic search is deliberately absent, and the shape above is what leaves room
for it. An embedding index would be a **derived table, never truth** — the same
standing as the SQLite index over git: `embedding(source_kind, source_id, ref,
chunk, vector)`, filled by a consumer of the event outbox (a `push` event
re-embeds the changed paths at the new tree; `issue.*` events re-embed one
conversation) and rebuildable from scratch by walking the bare repos and the
issue table, exactly as `core/reconcile.ts` rebuilds the index today. It would
plug in as a fourth source inside `search()`, ranked alongside the lexical hits
rather than replacing them, and gated by the same `listReposVisibleTo` pass — a
vector store that answers from repos the caller cannot read is a leak that no
amount of relevance makes acceptable. Nothing about adding it requires changing
the API shape: `{repos, issues, code, truncated}` gains a key.

## v1 scope

A forge that Just Works for a person and their crew: register/login, create
repo, push/pull over HTTPS with PATs, browse code (tree/blob/log/diff) with
syntax highlighting, README/markdown rendering, issues with labels and comments,
pull requests with a diff viewer / merge (merge-commit + squash) / conflict
detection / protected branches, repo settings, personal access tokens, and a
REST API over repos and issues. Fast on a phone. Deployable as one binary + git.

**Shipped so far:** foundation, diff engine, issues, pull requests + merge, the
diff viewer with syntax highlighting, review comments anchored by content hash,
commit pages, settings, webhook delivery from the event outbox (HMAC-signed,
retried), SSE live updates, forks (alternates-backed, detach-before-delete)
with cross-repo pull requests, organizations + teams with membership-based
permissions, an SSH transport (git and a terminal UI on one port), the
terminal UI itself, origins — connected GitHub/Forgejo/Gitea accounts,
mirrored repositories with imported issues and pulls, incremental sync,
write-through of contributions, and push-through of branches — the fork flow
(fork at the origin, branch from the live upstream, commit through the fork,
propose upstream with `owner:branch`, as one call), review states with a
merge gate and resolvable review threads, branches as a
first-class unit (create/delete with git's own leases, ahead/behind, and the
origin's word first on a mirror), editing files as one action (new branch and
a pull in the same call), open counts on every repo row through grouped
queries, and one search across local repos, cached origin repos, issues and
code.

Shipped since: apps (a repository that runs — production on the default
branch, a preview per open pull with its own copy of the data, served by
hostname from the forge's own port), runs (every deploy a durable, logged
run, and the run the check a pull's merge can require), and the crew
(agents as accounts with nothing but a run-scoped token, dispatched off the
outbox, working in Claude Code and proposing through pulls a person merges).

Not yet: containers around app processes, custom domains, a gate that
lands a pull on its own once review and checks agree, federation, package
registry.
