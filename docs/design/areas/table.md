# Scrolling table

A §5 `.table` too wide for a narrow screen sits inside a horizontal scroller, so the page itself never scrolls sideways and only the table's figures move.

- `.table-scroll` — the wrapper `<div>` around a wide `.table`: `overflow-x: auto` with a thin scrollbar, styled in `src/web/style/components.ts`. Pair it with `.table[data-sticky-lead]` to keep each row's name in view while the figures scroll. Written by `src/web/pages/account.ts`, `src/web/pages/audit.ts`, `src/web/pages/boards-held.ts`, `src/web/pages/crew.ts`, `src/web/pages/flow-panel.ts`, `src/web/pages/keeper-panel.ts`, `src/web/pages/passkeys.ts`, `src/web/pages/proposal-tokens.ts`, `src/web/pages/settings.ts`, `src/web/pages/spend.ts`, `src/web/pages/subscriptions.ts`, `src/web/pages/system.ts`, `fleetGraphSection`'s figures table in `src/web/fleet-graph.ts`, and `vitalsTable` in `src/web/studio/vitals.ts`.
