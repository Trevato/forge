# AGENTS.md

Read `CLAUDE.md` first: it is the rulebook for agents editing this repo.

README.md is capped: a new feature's how-to goes in `docs/features/<name>.md`, not a new README section.

When you write an issue, end it with a `Files:` line naming the files the work touches (`Files: src/a.ts, docs/b.md`). The hot-file hold reads only that line when it is there; without it, every path the issue mentions counts.

A new `forge` command is a new file in `src/cli/commands/` (exporting `command`) plus one line in its `index.ts`.

A new terminal screen offered only to site admins exports its palette `entry` from its own module and adds one line to `ENTRIES` in `src/tui/screens/entries.ts`; `after` names the commands it follows. Entries offered to everyone (the packs screen, `src/tui/screens/packs.ts`, is one), and entries gated by a helper (`mayCapacity`, `mayManageFlags`, `canSeeMemory`, `telemetryReader` and the like) rather than by `isAdmin`, stay in `forgeCommands` in `src/tui/forge.ts`.

A new read of a table that grows (`event`, `issue`, `run`, `comment`) names the index it walks, in the migration that adds it, and a test shows it from the query plan (`test/hot-reads-indexed.test.ts` is the pattern): no `SCAN`, no `TEMP B-TREE`. Judge by plan or row count, never the clock. A read that stays slow with the best index is a summary table, kept as the rows change, before it is a worker.

A new `/settings…` page route goes in `src/http/settings_routes.ts` (`settingsRoutes`), not `src/http/server.ts`.

State shared between modules through process memory, not the database, is named here. `src/perf/views_report.ts`: `readVisits` holds each scope and window's visits for 15 seconds (dropped by `flushViews`), so a page and its probe share one read; `src/perf/views_store.ts`: the view buffer, flushed every 10 seconds. The traffic sources view's terminal door is `src/tui/screens/trafficview.ts` (palette entry for admins, per-app command for a repository's admins). `src/runs/held.ts`: each dispatcher pass (`src/crew/dispatch.ts`, `pump`) records which queued agent runs it held and why (valve, pace, limit), and vitals (`src/kernel/vitals.ts`) leaves those out of `queue:agent`. A record older than `HELD_FRESH_MS` is ignored, so a stopped dispatcher cannot hide its queue. `src/apps/egress_refused.ts`: refused-host counts per repository, flushed to disk every 5 seconds (`flushRefused` forces it).

`src/perf/loop_worst.ts`: `loopWorst`, the worst event-loop lag of the last 10 s in ten one-second slots, fed by one unref'd 50 ms timer that the first `serve` starts (`startLoopWorst`), and read by every response's `lag;dur` and by `/healthz` asked for JSON (`loopLagMs`). Tests listing a request's phases read `requestTiming` (`test/helpers/request-timing.ts`), which leaves `lag` out.

`src/core/transfer.ts`: the old owner/name pairs a transfer left behind (`repo_redirect`), held per database after the first request reads them and dropped by `transferRepo`, so a request under a path nothing moved from costs no statement (#569).

## Awake ceiling and the boot
`FORGE_CHILD_AWAKE_MAX` counts forges in use. Hosted children the boot opens (so their apps come back) are exempt from `awakeCount` until a credentialed request reaches them or they sleep (`bootOpened` in `src/spawn/host.ts`). The exempt set holds only body ids of existing finished children and is emptied when the parent closes, so it is bounded by the number of children. Cell children are always counted; they are not opened by the boot.
