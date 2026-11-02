/**
 * The board (docs/DESIGN.md §5): the one layout no other component draws —
 * four live regions that fill a second monitor, each scrolling on its own,
 * one key to show one. Everything inside them is §5's: rows in a list card,
 * badges, meters, kbd. Assembled into the served stylesheet by
 * `web/style.ts`, last in the `components` layer. The spend tables
 * (`spend.ts`) wear §5's table and stack, with no rules here.
 */
export const boardCss = /* css */ `
@layer components {
.board { --pad: clamp(16px, 2.2vw, 32px); display: flex; flex-direction: column; min-height: 100dvh; }
.board > header, .board > .stack { padding: 12px var(--pad) 0; }
.board > #notes { padding: 8px var(--pad) 0; }
#notes ul { list-style: none; margin: 4px 0 0; padding: 0; max-height: 30dvh; overflow: auto; }
#notes li > * { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-height: 44px; overflow-wrap: anywhere; }
#notes li > a { display: block; padding-block: 12px; min-height: 0; }
.board #board-live { display: inline-flex; align-items: center; }
.board #board-clock { min-width: 5ch; text-align: right; }
.board [data-started] { min-width: 7ch; text-align: right; }
.board-grid { flex: 1; display: grid; gap: var(--pad); padding: 16px var(--pad) var(--pad); min-height: 0; }
.board-region { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
.board-region > h2 { display: flex; align-items: center; gap: 8px; margin: 0; }
.board-region[data-fresh] > h2 { color: var(--accent); }
.board-region .row-lead img { display: block; border: 1px solid var(--border); border-radius: 4px; object-fit: cover; object-position: top; }
.board-region .row-main > meter { margin-top: 4px; }
.board [data-window] > meter { width: 56px; }

/* Wide: four regions fill the window, each list scrolling on its own. */
@media (min-width: 1100px) {
  .board { height: 100dvh; min-height: 0; }
  .board-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); }
  .board-region > .card { min-height: 0; overflow: auto; scrollbar-width: thin; }
  .board[data-focus] .board-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
}
/* One region, full bleed. */
.board[data-focus] .board-region { display: none; }
.board[data-focus="working"] #working, .board[data-focus="landed"] #landed,
.board[data-focus="decided"] #decided, .board[data-focus="today"] #today { display: flex; }
/* Read from across the room: one region, or the wall mode, at a larger
   scale — the same rows, every size in proportion. Nobody is at the keys. */
.board[data-focus] .board-region > * { zoom: 1.3; }
.board[data-wall] .board-region > *, .board[data-wall] > .stack { zoom: 1.4; }
.board[data-wall] { cursor: none; }
.board[data-wall] #notes :is(.input, .btn) { display: none; }
}
`;
