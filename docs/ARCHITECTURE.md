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
  main.ts            boot: open db, ensure dirs, mount server, start workers
  kernel/            zero-dep primitives: result, error, id, log, db
  git/               bare repos, smart HTTP, batch readers, hooks, ref guards
  core/              domain: users, sessions, tokens, repos, issues, pulls, events
  http/              router, middleware (auth, csrf, csp), api routes
  web/               SSR: html template tag, design tokens, pages, components
  test/              bun test — protocol-level and adversarial
```

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
  access token over TLS; 401 + `WWW-Authenticate` challenge. SSH is a later
  additive (forced-command dispatcher), not a redesign.
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

State transitions use compare-and-swap (`UPDATE … WHERE state = ?`), and every
transition writes its event row in the same transaction. On boot, a
reconciliation sweep repairs the index from git (a merged branch whose pull row
says "open" gets healed from the ref state, not trusted).

Two lessons Forgejo is still paying for, designed in up front:

- **Merge results stay reachable forever.** Merging a pull writes a durable
  `refs/pull/<n>/merged` ref in the same operation — a merged commit can never
  become unreachable through base-branch deletion plus gc (Forgejo #30972).
- **Review comments anchor to content, not coordinates.** A comment stores the
  blob line _content hash_ alongside file/line, so a force-push either
  re-anchors it exactly or marks it outdated explicitly — never silently lands
  it on the wrong line (Forgejo #21113).

## The web

- **SSR from tagged template literals**: an `html` tag that auto-escapes
  interpolations (opt-out is explicit and greppable). Components are functions
  returning safe strings. No hydration framework — pages are fast HTML with
  surgical vanilla JS: URL-as-state (the nuqs pattern, ~15 lines), SSE for
  live updates, `data-*` attributes as the style/behavior hooks.
- **Design system**: a flat namespace of CSS custom properties — one `:root`
  block, one `.dark` override — is the entire theming machinery. shadcn's
  essence without Tailwind: tokens, radii, spacing scale, semantic colors.
  Strict CSP on every response.
- **Mobile-first**: layouts compose from a single column up; touch targets
  ≥44px; the fast paths (open issue, comment, review a diff, merge) are
  designed on a phone frame first and enhanced for desktop.

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

## v1 scope

A forge that Just Works for a person and their crew: register/login, create
repo, push/pull over HTTPS with PATs, browse code (tree/blob/log/diff) with
syntax highlighting, README/markdown rendering, issues with labels and comments,
pull requests with a diff viewer / merge (merge-commit + squash) / conflict
detection / protected branches, repo settings, personal access tokens, and a
REST API over repos and issues. Fast on a phone. Deployable as one binary + git.

**Shipped so far:** foundation, diff engine, issues, pull requests + merge, the
diff viewer with syntax highlighting, review comments anchored to diff lines by
content hash, commit pages, settings, and webhook delivery from the event
outbox (HMAC-signed, retried).

Not in v1: SSH transport, forks/alternates UX, org teams, CI runners (the
events + API surface is designed so a runner integrates without core changes),
SSE live updates, federation, package registry.
