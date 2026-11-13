/**
 * The new home (`home_flow.ts`): six lanes of tiles under a strip of figures.
 * Everything is a token from `design/themes.ts`, a size from the type scale
 * and a space from the spacing scale; the lanes are the one layout no other
 * component draws, the tiles are small cards. Assembled into the served
 * stylesheet by `web/style.ts`, in the `components` layer.
 *
 * Six lanes across on a desk, three by two on a tablet, one under the other
 * on a phone (where a lane shows its first three tiles and counts the rest).
 * Motion is two things only, an arrival wash and a pulse on work in progress,
 * and both stop for a reader who asked for less.
 */
export const homeFlowCss = /* css */ `
@layer components {
.hf { display: flex; flex-direction: column; gap: 16px; padding-top: 16px; }
.hf-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.hf-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; }
.hf-live { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: var(--fs-min); }
.hf-filter { display: flex; align-items: center; gap: 8px; }
.hf-filter-label { font-size: var(--fs-min); color: var(--muted-fg); }
.hf-filter .input { min-height: 44px; max-width: 220px; }

/* ---- the strip ---- */
.hf-strip { display: flex; flex-direction: column; gap: 8px; }
.hf-head + .hf-strip { margin-top: -8px; }
.hf-calm, .hf-need, .hf-forges { display: flex; align-items: center; gap: 8px; margin: 0; min-height: 24px; font-size: 13px; color: var(--muted-fg); }
.hf-need { min-height: 44px; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border)); border-radius: var(--radius); background: color-mix(in srgb, var(--danger) 8%, var(--card)); font-size: 14px; color: var(--fg); }
.hf-need a { text-decoration: underline; text-underline-offset: 2px; }
.hf-need-more { color: var(--muted-fg); white-space: nowrap; }
.hf-figs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); box-shadow: var(--shadow-1); }
.hf-fig { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; min-height: 44px; padding: 12px 16px; background: var(--card); box-shadow: 0 0 0 0.5px var(--border); }
.hf-fig:hover { background: var(--muted); color: var(--fg); }
.hf-fig:last-child:nth-child(odd) { grid-column: 1 / -1; }
.hf-fig-label { font-size: var(--fs-min); color: var(--muted-fg); }
.hf-fig-value { font-size: 20px; font-weight: 600; line-height: 28px; letter-spacing: -0.01em; }
.hf-fig-note { font-size: var(--fs-min); line-height: 16px; color: var(--muted-fg); overflow-wrap: anywhere; }
.hf-fig-spark { position: absolute; top: 12px; right: 16px; width: 56px; height: 24px; color: var(--accent); }
.hf-fig-spark svg { display: block; width: 100%; height: 100%; }
.hf-fig[data-tone="attn"] .hf-fig-value, .hf-fig[data-tone="attn"] .hf-fig-note { color: var(--attn); }

/* ---- the lanes ---- */
.hf-lanes { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; }
.lane { --tone: var(--border-strong); display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 12px 8px 8px; border-top: 2px solid var(--tone); border-radius: var(--radius); background: color-mix(in srgb, var(--muted) 70%, transparent); }
.lane[data-tone="flowing"] { --tone: var(--success); }
.lane[data-tone="stuck"] { --tone: var(--danger); }
.lane-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding-inline: 4px; }
.lane-name { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: 0; }
.lane-name-link { display: inline-flex; align-items: center; min-height: 44px; margin-block: -12px; }
.lane-count { font-size: 20px; font-weight: 600; line-height: 24px; letter-spacing: -0.01em; }
.lane[data-count="0"] .lane-count { color: var(--faint); }
.lane-health { margin: 0; padding-inline: 4px; font-size: 12.5px; line-height: 18px; color: var(--muted-fg); }
.lane-state { display: inline-flex; align-items: center; gap: 4px; margin-right: 4px; font-weight: 600; color: var(--fg); white-space: nowrap; }
.lane-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }

/* ---- a tile ---- */
.tile { position: relative; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); box-shadow: var(--shadow-1); }
.tile:hover { border-color: var(--border-strong); }
.tile[data-state="active"] { border-left: 2px solid var(--accent); }
.tile[data-state="done"] { border-left: 2px solid var(--success); }
.tile-link { display: flex; flex-direction: column; gap: 4px; min-height: 44px; padding: 8px 12px; color: var(--fg); }
.tile-link:hover { color: var(--fg); }
.tile-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; font-size: var(--fs-min); line-height: 16px; }
.tile-app { min-width: 0; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.tile-no { font-weight: 400; color: var(--muted-fg); }
.tile-clock { flex: none; color: var(--muted-fg); font-variant-numeric: tabular-nums; }
.tile[data-state="active"] .tile-clock::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; vertical-align: 1px; border-radius: 999px; background: var(--accent); animation: hf-pulse 1.8s ease-in-out infinite; }
.tile-title { display: -webkit-box; overflow: hidden; font-size: 13px; line-height: 18px; overflow-wrap: anywhere; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.tile-hint, .tile-more { font-size: var(--fs-min); line-height: 16px; color: var(--muted-fg); }
.tile-who { font-weight: 600; color: var(--fg); }
.tile[data-new] { animation: hf-arrive 900ms var(--ease); }
.lane-more { margin: 0; padding-inline: 4px; font-size: 13px; }
.lane-more a { display: block; color: var(--muted-fg); }
.lane-more a:hover { color: var(--accent); }
.lane-more span { align-items: center; min-height: 44px; }
.lane-more-sm { display: inline-flex; }
.lane-more-md, .lane-more-lg { display: none; }
.lane-more span:empty { display: none; }
.hf-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 0 16px; margin: 0; }
.hf-foot a, .hf-forges a, .hf-need a { display: inline-flex; align-items: center; min-height: 44px; }
@keyframes hf-arrive { from { background: color-mix(in srgb, var(--accent) 18%, var(--card)); } to { background: var(--card); } }
@keyframes hf-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .tile[data-new], .tile[data-state="active"] .tile-clock::before { animation: none; }
}

/* A phone: a lane is a glance, its first tile and the count of the rest; the figures keep their numbers and drop their notes. */
@media (max-width: 719px) {
  .hf { gap: 12px; padding-top: 8px; }
  .lane-list .tile:nth-child(n+2) { display: none; }
  .lane-health { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .tile-title { -webkit-line-clamp: 1; }
  .hf-fig { padding: 8px 12px; }
  .hf-fig-note { display: none; }
  .hf-fig:last-child .hf-fig-note { display: block; }
  .hf-fig-spark { right: 12px; top: 8px; }
  .lane-more { display: none; }
  .hf-head { flex-wrap: nowrap; align-items: flex-start; }
  .hf-filter-label { display: none; }
  .hf-filter .input { min-height: 44px; max-width: 150px; }
  .hf-title { flex-direction: column; gap: 0; }
}
@media (min-width: 720px) {
  .hf-figs { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .hf-fig:last-child:nth-child(odd) { grid-column: auto; }
  .hf-lanes { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .lane-more-sm { display: none; }
  .lane-more-lg { display: inline-flex; }
}
@media (min-width: 1100px) {
  .hf-lanes { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .lane-health { min-height: 72px; }
}
/* A short desk screen: four tiles a lane keeps the whole picture in view. */
@media (min-width: 1100px) and (max-height: 960px) {
  .lane-list .tile:nth-child(n+5) { display: none; }
  .lane-more-lg { display: none; }
  .lane-more-md { display: inline-flex; }
}
}
`;
