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
10. **The crew proposes; a person lands.** An agent (`user.kind === "agent"`)
    never moves the default branch — the pre-receive hook refuses it,
    protected or not — and `mergePull` refuses an agent actor. Its only grant
    is `repo_crew` (read + write, never admin); its only credential is a
    token minted for a run with an expiry, deleted when the run ends. Never
    give an agent a path around these (`docs/APPS.md`, rule 1 and 6).
11. **A child inherits nothing it was not handed.** App and agent processes
    start from `childEnv` (`apps/process.ts`) — an explicit, short
    environment — never from the forge's own, which carries secrets. A
    preview's data is a copy of production's, never a path to it. And it
    runs in a cell (`apps/contain.ts`): never a plain child where the host
    can hold one.

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
- **A test's git child gets a built environment, never the host's.** Use
  `gitClientEnv` (`test/helpers/git-client.ts`) — `...process.env` carries
  `GIT_CONFIG_COUNT` (git configuration no `GIT_CONFIG_GLOBAL=/dev/null`
  turns off, and on a crew machine it holds that agent's forge credential)
  into a child pointed at a forge that never issued it. Same rule as
  `src/git/env.ts` server-side.
- **A test that needs a binary this machine may lack skips, and says so.**
  `describe.skipIf(missing("/usr/bin/ssh"))` (`test/helpers/tools.ts`) —
  conditional on the tool, so nothing is lost where the tool is there, and
  the reason is printed so a skip is never read as a pass.
- **`bun run check` is the gate**, and it reads its command from
  `forge.json`, so what you see is exactly what the push will be judged by.
  **The forge runs it on every push; a crew run does not.** Before pushing,
  run `bun x tsc --noEmit` and ONE `bun test` call with the test files of
  what you touched plus the five cross files that catch crossed merges —
  `test/reserved-names.test.ts`, `test/studio.test.ts`, `test/shards.test.ts`
  (the gate list), `test/check-list.test.ts`, `test/hollow.test.ts`. Never
  `bun scripts/test-shards.ts --gate` inside a run: the check on your push is
  that same gate, and running both doubles the load on a small machine.
  It runs the files in `GATE` (`scripts/gate.ts`), not the whole suite; every
  other test file is in `EXCLUDED` with its reason and owning issue. Add a new
  test file to `GATE`, or the check goes red.
- **Every non-trivial change ships with a test.** Prefer protocol-level tests
  that boot a real app (`createApp` + `serve`) over unit mocks. Adversarial
  tests (can this be bypassed?) are worth more than happy-path ones.
- **Done means reachable.** A new action is called from a route, a page or an
  MCP tool in the same pull, and a new screen is linked from a page a person
  can get to. `scripts/hollow.ts` (run by `test/hollow.test.ts` in the gate,
  or `bun scripts/hollow.ts`) names an exported function in `src/actions/`
  that nothing that runs reaches (a page function no route names does not
  count as a caller) and a screen no page links to.
  `scripts/hollow-allow.ts` is for hollow work an issue already owns, never
  for new work.
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
              plumbing, no work tree), write (commit via plumbing, deletes as
              index-info mode 0, a `land` hook so an origin answers first),
              branches (create/delete via update-ref leases, ahead/behind),
              repos (fork via alternates), smart-http, smart-ssh
              (exec-channel git), hooks (+ hook-entry, guard)
  core/       domain: users (kind user|org), sessions, tokens (ro/rw/admin),
              repos (access checks, grouped `countsForRepos`), issues
              (issue|pull, grouped `labelsForIssues`/`commentCounts`), pulls,
              reviews, orgs/teams, webhooks, keys (ssh public keys), search
              (repos/issues/`git grep`, all bounded), events (outbox+bus),
              reconcile, schema, usage (what each agent run spent: tokens,
              cost, wall time, by subscription/app/agent/issue) — pure
              data, no authz, no events
  actions/    one function per platform mutation: authorize (access.ts tiers),
              call core, `bus.append`. API, web, and TUI are adapters over
              these. branches.ts also owns `originPush` — how a mirror's ref
              updates reach its origin — and contents.ts is the whole edit
              (files, a new branch, a pull) as one call
  http/       router, request context (Ctx/auth), respond (json/error shapes,
              scope floors, pagination, `securityFloor` — the headers every
              response leaves with), api (every /api/v1 route), server
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
              org,account,settings}, and studio/ — the app-as-the-unit
              surface, one module per concept: words (the vocabulary every
              page says it in), asks, previews, shelf (an app as one
              row, for any page that lists apps), home, app, change, tell,
              run, lists, actions, style (the page sheet, assembled)
  feed/       a viewer's feed (docs/FEED.md): items (candidates read through
              the access every page uses), affinity (decayed counts), rank,
              feed (filter, page, cursor)
  ssh/        the SSH server: transport (kex/ciphers), auth (publickey),
              channels (session only), keys, wire — zero deps, no forwarding
  tui/        the terminal UI. term/ is the transport boundary (`Terminal`);
              app/ is the loop (screen stack, keys, palette); ui/ is the widget
              vocabulary; screens/* are adapters over actions/; forge.ts is the
              root + palette; ssh.ts is the front door (identity, git exec,
              `serveForgeSsh`); main.ts is the stdio dev runner
  apps/       a repository that runs (docs/APPS.md): manifest (forge.json,
              fail-closed), checkout (a commit exported with read-tree +
              checkout-index), data (per-environment dirs, copy-on-write
              seeding, SQLite quiesce), process (install/test/start/ready,
              explicit child env), contain (the cell repository code
              runs in: bubblewrap, a watch on memory/CPU/disk), egress
              (the cell's one way out: a proxy to declared hosts) and
              egress_report (what was reached undeclared, reported), runtime (environments in memory, rebuilt
              on boot, serial deploys per env, crash restarts bounded),
              proxy (Host routing, signed grants for private apps), scaffold
              (the app a new app starts as), tty (`ssh <slug>@forge`: the
              app's own terminal on a pty)
  fleet/      one action over many rows (docs/FLEET.md): selection (the
              query line → row ids, only what the viewer reads), verbs (each
              action as read/next/refuse/write over one row, writing through
              actions/); actions/fleet.ts plans, applies, keeps the receipt
              (core/fleet_ops.ts) and undoes
  runs/       log (one file per run, appended live, tailed by listeners)
  crew/       agents as child processes: brief (the system + task prompts:
              the golden path, written down), claude (the headless adapter:
              argv, stream-json, outcome), sandbox (what the agent's shell
              may reach and read), workdir (where clones live), runner (one
              run: token, clone, branch, Claude, push, open/update the pull,
              report, reap leftovers), dispatch (outbox consumer + sweep +
              worker tick), running (in-flight runs, for cancel)
  design/     themes, and activity (what an event is called, for both
              surfaces)
```

Three tables carry all of it: `app` (slug, access, preview data policy),
`run` (kind deploy|agent, state by compare-and-swap, summary, cost) and
`agent` (model, brief, budget) plus `repo_crew`, `app_env` (the operator's
variables, sealed, write-only) and `issue.assignee_id`. What
is _running_ is not state: `AppsRuntime.start` rebuilds every environment
from the default branch and the open pulls.

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
  order, once each, recognised by a hash of their text in `schema_migration`
  — see `kernel/migrate.ts`). Never edit an existing migration — an edited
  one is a new one and runs again. Add a new one.
- **New git read:** put it in `git/read.ts`; reuse the long-lived `cat-file`
  batch reader rather than spawning per object. Run every rev/path through
  `assertBatchSafe`.
- **New event type:** add it where you append it; make sure a reconcile sweep or
  consumer can tolerate a missed or duplicated delivery (outbox semantics).
- **Anything that returns a list of rows:** never fetch a per-row fact in a
  loop. Add a grouped helper beside the singular one (`countsForRepos`,
  `labelsForIssues`, `commentCounts` are the pattern: ids in, `Map` out, one
  query per chunk) and use it from the adapter. `test/counts.test.ts` asserts
  a listing's SQL statement count does not grow with its row count.
- **Touching a mirrored repo:** the origin is truth (`docs/ORIGINS.md`). A
  local-only write on a mirror is a bug, so the sync actions refuse one
  (`"mirrored"`) and the `…Through` twins write to the origin first. Never
  put a credential in argv or a URL — `origins/credentials.ts` is the only
  way one reaches git.
- **Moving a ref on a mirror:** `update-ref` runs no hooks, so nothing forwards
  it for you. Resolve `originPush` (`actions/branches.ts`) first: `undefined`
  means a native repo and the ref moves locally; otherwise push upstream and
  move the local ref only if the origin took it. `git/write.ts`'s `land` hook
  is the same rule for a commit — objects written, ref held back until the
  origin agrees.

- **Anything a worker records (a run's state, an app's environment):** the
  worker calls `announceRun` (`actions/runs.ts`) or another action — never
  `bus.append` itself. `apps/runtime.ts` and `crew/*` are workers, not
  adapters, and still speak only through actions.
- **A new reason for an agent to run:** add the trigger in
  `crew/dispatch.ts`'s `route` (an outbox event → `queueAgentRun`), name the
  reason in `brief.ts`'s `RunReason` and write what the agent is told for it
  in `taskPrompt`. Bound it: anything automatic (not a person speaking) must
  count against a limit the way `check_failed` does.
- **Something an app process needs to know:** add it to `appEnv`
  (`apps/process.ts`) and document it in `docs/APPS.md`'s table. Never pass
  the forge's own environment through.

## Not yet built (deliberately)

A self-describing (OpenAPI) endpoint, container images for app processes
(they run in a cell — `apps/contain.ts` — not an image),
custom domains, and a gate that lands a pull on its own once review and
checks agree. The event outbox and API surface are shaped so these arrive
as additions, not rewrites. `docs/ARCHITECTURE.md` closes with the
reasoning. "Forgejo is my harness" is the north star — automation is a
first-class user, not an afterthought, and `docs/APPS.md` is where that
user now lives.
