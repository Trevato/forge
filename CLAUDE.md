# CLAUDE.md — working in this repo

Orientation for an agent editing forge. Read this first, then `README.md` (what
it is) and `docs/ARCHITECTURE.md` (why it's shaped this way). This file is the
rulebook: the invariants you must not break, and how to work here.

The whole point of forge is that **one person can hold it in their head**. Every
change should leave it that way. When something fights you, step up and
understand the system before adding code — a workaround usually means the system
isn't understood yet.

## Invariants — do not break these

1. **Zero runtime dependencies.** `package.json` `dependencies` is empty and
   stays empty. Never `bun add` a runtime dep. Need a 20-line utility? Write it
   as a 20-line file. `devDependencies` is types + `tsc` only.
2. **Bun, not npm/yarn/pnpm.** Install, run, test, build all go through `bun`.
   The runtime provides everything: `Bun.serve`, `Bun.spawn`, `bun:sqlite`,
   `Bun.password` (argon2), WebCrypto, gzip.
3. **Real git, thin wrapper.** Never reimplement pack negotiation, diff, blame,
   or merge. Spawn the `git` binary and plumb bytes carefully. Correctness comes
   from git; our job is safe arguments and clean I/O.
4. **Git is truth; the DB is a derived index.** SQLite holds nothing that can't
   be rebuilt from the bare repos. `core/reconcile.ts` self-heals the index from
   git on boot. Don't invent state that lives only in the DB (or only in memory).
5. **State changes go through the event outbox.** Every meaningful mutation
   `bus.append(...)`s a durable event (`core/events.ts`). Webhooks and SSE ride
   that outbox; delivery is retried. Never fire-and-forget something important.
6. **Protections are mechanical, proven by tests.** Access (`canRead/canWrite/
canAdmin`), token scope (`readForm` floor + `minScope`), and branch
   protection are enforced in code paths with tests that prove the bypass is
   impossible — never by convention or comment.
7. **Two error tiers.** Expected outcomes → `Result<T,E>` (`kernel/result.ts`).
   Bugs/impossible states → `defect(...)` / `ForgeError` (`kernel/error.ts`).
   Don't throw for expected failures; don't `Result`-wrap a programmer error.
8. **Git argument hygiene.** Any rev/path handed to git passes the safety checks
   (`assertBatchSafe`, `isSafeRef`) — no user string may become a git flag or
   carry control bytes. This is a security boundary, not a nicety.
9. **`not_found` is deliberately ambiguous.** A missing resource and a resource
   you can't see both return `not_found`, so private repos never leak their
   existence. Keep that conflation when you add routes.

## How to work

```sh
bun test              # full suite — must stay green
bun x tsc --noEmit    # zero type errors is the standard (strict, exact-optional)
bun run src/main.ts   # boots on :3000, data in ./data
```

- **Formatting/lint runs on save** (a hook) — don't hand-format; don't fight it.
- **`git push` is blocked at the shell level.** In tests and scripts that need a
  git _client_, drive it through `Bun.spawn(["git", ...])`, never a shell push.
  See `test/app.test.ts` / `test/onboarding.test.ts` for the pattern.
- **Every non-trivial change ships with a test.** Prefer protocol-level tests
  that boot a real app (`createApp` + `serve`) over unit mocks. Adversarial
  tests (can this be bypassed?) are worth more than happy-path ones.
- **TypeScript is strict**: `noUncheckedIndexedAccess` (index access is `T |
undefined` — handle it), `exactOptionalPropertyTypes` (don't pass `undefined`
  where a key should be absent), `verbatimModuleSyntax` (`import type`), and
  `.ts` extensions on relative imports.
- Commit only when asked; imperative subject; end the message with
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## The map

```
src/
  main.ts     boot: hook dispatch, reconcile, serve (http + ssh), delivery worker
  app.ts      composition root — one data dir = one forge (dataDir is resolved
              absolute here; the hook socket depends on it)
  kernel/     zero-dep primitives: result, error, id (monotonic ULID), log,
              db (sqlite/WAL), hash
  git/        env (runGit*), read (cat-file batch readers), diff, merge (bare
              plumbing, no work tree), write (commit via plumbing), repos
              (fork via alternates), smart-http, smart-ssh (exec-channel git),
              hooks (+ hook-entry, guard)
  core/       domain: users (kind user|org), sessions, tokens (ro/rw/admin),
              repos (access checks), issues (issue|pull), pulls, reviews,
              orgs/teams, webhooks, keys (ssh public keys), events
              (outbox+bus), reconcile, schema — pure data, no authz, no events
  actions/    one function per platform mutation: authorize (access.ts tiers),
              call core, `bus.append`. API, web, and TUI are adapters over these
  http/       router, request context (Ctx/auth), respond (json/error shapes,
              scope floors, pagination), api (every /api/v1 route), server
              (auth resolution, git smart HTTP, web routes, hook socket), sse
  design/     shared design tokens: themes (palettes both surfaces render)
  origins/    other forges as one Provider interface: discover (version-endpoint
              probe), providers/{github,forgejo} (+ http: paging, ETags, rate
              limits), oauth (device grant + PKCE code flow), credential (lazy
              token, serialised refresh), credentials (git auth env, redaction),
              git-mirror (refspecs, leases), import, sync, mirror (+ jobs: the
              staged, watchable mirror), push-through
  view/       one repository, read from either side: source (the RepoSource
              interface both surfaces render), local (git + core), origin
              (a Provider, live), cache (per-process, TTL + LRU)
  web/        SSR. html (the tag), icons (Lucide SVG), ui (the component
              vocabulary — docs/DESIGN.md is its contract), chrome (repo
              header, settings shell, the one 404), flash, layout (CSP+nonce,
              topbar, theme switcher), client (progressive enhancement, as a
              string), style/{base,components,content} assembled by style.ts,
              markdown, highlight, code, worddiff, diff-view, live, and
              pages/{site,repo,issues,pulls,pull,thread,commits,refs,search,
              org,account,settings}
  ssh/        the SSH server: transport (kex/ciphers), auth (publickey),
              channels (session only), keys, wire — zero deps, no forwarding
  tui/        the terminal UI. term/ is the transport boundary (`Terminal`);
              app/ is the loop (screen stack, keys, palette); ui/ is the widget
              vocabulary; screens/* are adapters over actions/; forge.ts is the
              root + palette; ssh.ts is the front door (identity, git exec,
              `serveForgeSsh`); main.ts is the stdio dev runner
```

Two rules the TUI must keep. `tui/term/` is the transport boundary — no screen,
widget or loop code reaches past it to `process`, which is what lets one runtime
serve stdio, an SSH channel and a headless test with no branch anywhere. And a
session acts as the account its **key** maps to and nothing else; the `--user`
flag exists only in the stdio dev runner and is never reachable over SSH.

## Recipes

- **Add a mutation:** write it once as an action in `actions/<concept>.ts` —
  `(app, actor, …) => Result`. Authorize first with the `access.ts` helpers
  (`requireParticipant` / `requireWriter` / `requireRepoAdmin` /
  `requireOrgAdmin`), call the core function, then `bus.append(...)`. Never
  authorize or append events in an adapter; `grep bus.append` outside
  `actions/` should find only the post-receive hook.
- **Add an API route:** register in `apiRoutes` (`http/api.ts`). Resolve the
  repo with `loadRepo` (readable or `notFound()`); for writes enforce the token
  scope floor (`requireScope`, or `requireAccount` for account-level changes),
  call the action, and map its Result with `respondAccess(error, status)` —
  access errors have fixed shapes, anything else is a 422 code. Lists are
  `{ items, next_cursor }` via `paged(...)`. Web forms follow the same shape
  via `readForm(ctx, scope)`.
- **Add a TUI screen:** one file under `tui/screens/`, exporting
  `(f: Session, ctx: Ctx, …) => Screen`. Compose `ui/widgets`; take navigation
  from `screens/common.ts` (`ListState`, `Scroll`, `Filter`, `drawList`,
  `confirmScreen`/`promptScreen`/`pickerScreen`); load in `load(signal)` and
  register anything long-lived against that signal. Mutations call an action
  with `f.user` as the actor and surface a failed `Result` through
  `ctx.toast(errorText(error), "danger")`. Reads go through the same
  `canRead`/`canWrite`/`canAdmin` helpers the web uses — a screen is a client,
  never a way around them.
- **API error shape:** every error is `{ error, message }` — `error` is a stable
  machine code to branch on, `message` a human hint. Reuse the helpers
  (`notFound`, `noRoute`, `unauthorized`, `forbidden`) or a specific 422 code;
  don't invent a new shape.
- **Add a schema change:** append a migration to `core/schema.ts` (they run in
  order, once). Never edit an existing migration — add a new one.
- **New git read:** put it in `git/read.ts`; reuse the long-lived `cat-file`
  batch reader rather than spawning per object. Run every rev/path through
  `assertBatchSafe`.
- **New event type:** add it where you append it; make sure a reconcile sweep or
  consumer can tolerate a missed or duplicated delivery (outbox semantics).
- **Touching a mirrored repo:** the origin is truth (`docs/ORIGINS.md`). A
  local-only write on a mirror is a bug, so the sync actions refuse one
  (`"mirrored"`) and the `…Through` twins write to the origin first. Never
  put a credential in argv or a URL — `origins/credentials.ts` is the only
  way one reaches git.

## Not yet built (deliberately)

CI runners / a checks API on PRs, a self-describing (OpenAPI) endpoint, and the
AI build crew. The event outbox and API surface are shaped so these arrive as
additions, not rewrites. `docs/ARCHITECTURE.md` closes with the
reasoning. "Forgejo is my harness" is the north star — automation is a
first-class user, not an afterthought.
