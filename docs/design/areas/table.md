# Scrolling table

A §5 `.table` too wide for a narrow screen sits inside a horizontal scroller, so the page itself never scrolls sideways and only the table's figures move.

- `.table-scroll` — the wrapper `<div>` around a wide `.table`: `overflow-x: auto` with a thin scrollbar, styled in `src/web/style/components.ts`. Pair it with `.table[data-sticky-lead]` to keep each row's name in view while the figures scroll. Written by `src/web/pages/account.ts`, `src/web/pages/audit.ts`, `src/web/pages/boards-held.ts`, `src/web/pages/crew.ts`, `src/web/pages/flow-panel.ts`, `src/web/pages/keeper-panel.ts`, `src/web/pages/passkeys.ts`, `src/web/pages/proposal-tokens.ts`, `src/web/pages/settings.ts`, `src/web/pages/spend.ts`, `src/web/pages/subscriptions.ts`, `src/web/pages/system.ts`, `fleetGraphSection`'s figures table in `src/web/fleet-graph.ts`, and `vitalsTable` in `src/web/studio/vitals.ts`.

- The data browser (#7580, `src/web/pages/data_view.ts`) adds no class. A sortable `.table` carries `data-sortable`; its sorted header has `aria-sort`, and `style/components.ts` draws a muted arrow after the link from that attribute. A cell's JSON is a `<pre>` inside the `td`. The grid scrolls sideways only; 50 rows a page keep it in the page's flow, so there is no max-height box and no sticky header.
