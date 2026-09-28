/**
 * The big view's stylesheet: a k9s frame in the browser. One header line,
 * a body of panes that fill the window and scroll on their own, one footer
 * line of key chips. Dense, calm, dark by default; the forge's tokens
 * throughout, so every theme gets it. Nothing here animates on its own —
 * a focus ring moves, a hover tints, and that is all the motion there is.
 */

/** Width rules for the bars: a whole percentage as `data-w`, since an inline style is not allowed. */
const widths = Array.from(
  { length: 101 },
  (_, n) => `.big-fill[data-w="${n}"] { width: ${n}%; }`,
).join("\n");

export const bigCss = /* css */ `
.big {
  --gap: 10px; --line: 30px;
  height: 100dvh; display: grid; grid-template-rows: var(--line) minmax(0, 1fr) var(--line);
  font-size: 13px; line-height: 1.4; overflow: hidden;
  font-variant-numeric: tabular-nums;
}
.big kbd { height: 18px; min-width: 18px; padding: 0 4px; font-size: 10.5px; border-bottom-width: 1px; }
.big .num, .big .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.big .spacer { flex: 1; }

/* ---- the header line ---- */
.big-top { display: flex; align-items: center; gap: 12px; padding: 0 12px; border-bottom: 1px solid var(--border); color: var(--muted-fg); font-size: 12.5px; white-space: nowrap; min-width: 0; }
.big-brand { display: inline-flex; align-items: center; gap: 7px; font-weight: 650; letter-spacing: -0.03em; font-size: 13.5px; color: var(--fg); }
.big-brand .mark { width: 9px; height: 9px; border-radius: 3px; background: linear-gradient(135deg, var(--accent), var(--merged)); }
.big-crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
.big-crumbs a { color: var(--muted-fg); }
.big-crumbs a:hover { color: var(--fg); }
.big-crumbs > span { color: var(--faint); }
.big-crumbs b { color: var(--fg); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.big-hint { font-size: 12px; color: var(--muted-fg); overflow: hidden; text-overflow: ellipsis; }
.big-hint[data-tone="danger"] { color: var(--danger); }
.big-hint[data-tone="success"] { color: var(--success); }
.big-live { display: inline-flex; align-items: center; }
.big-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--faint); }
.big-live[data-state="open"] .big-dot { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent); }
.big-live[data-state="reconnecting"] .big-dot { background: var(--attn); }
.big-clock { font-family: var(--mono); font-size: 12.5px; color: var(--muted-fg); min-width: 5ch; text-align: right; }
.big-pad { display: none; font-size: 11px; color: var(--faint); }
.big[data-pad] .big-pad { display: inline; }

/* ---- the body of panes ---- */
.big-body { display: grid; gap: var(--gap); padding: var(--gap); min-height: 0; }
.big-body[data-layout="home"] { grid-template-columns: minmax(0, 11fr) minmax(0, 9fr); }
.big-body[data-layout="app"], .big-body[data-layout="wall"] { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
.big-body[data-layout="run"], .big-body[data-layout="lanes"], .big-body[data-layout="list"] { grid-template-columns: minmax(0, 1fr); }
.big-pane {
  min-width: 0; min-height: 0; display: flex; flex-direction: column;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--card);
}
.big-pane.is-pane { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.big-h {
  flex: none; display: flex; align-items: center; gap: 8px; margin: 0; padding: 0 10px; height: 28px;
  border-bottom: 1px solid var(--border);
  font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted-fg);
  white-space: nowrap; overflow: hidden;
}
.big-pane.is-pane .big-h { color: var(--fg); }
.big-h kbd { letter-spacing: 0; }
.big-count { font-weight: 500; letter-spacing: 0; color: var(--faint); }
.big-h-note { font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--faint); overflow: hidden; text-overflow: ellipsis; }
.big-h-note b { color: var(--fg); font-weight: 600; }
.big-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: var(--border) transparent; overscroll-behavior: contain; }
.big-rows { margin: 0; padding: 4px 0; list-style: none; }
.big-quiet { margin: 0; padding: 10px 12px; color: var(--faint); }
.big-pane[data-fresh] .big-h { color: var(--accent); }

/* ---- rows ---- */
.big-row {
  position: relative; display: grid; align-items: center; gap: 2px 10px;
  padding: 5px 10px 5px 12px; border-left: 2px solid transparent; color: inherit; outline: none;
  cursor: default;
}
.big-row:hover { background: color-mix(in srgb, var(--fg) 4%, transparent); }
.big-row.is-focus { background: color-mix(in srgb, var(--accent) 13%, transparent); border-left-color: var(--accent); }
.big-row a { color: inherit; }
.big-row[data-busy] { opacity: .5; }
.big-t { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.big-m { color: var(--muted-fg); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.big-m b { color: var(--fg); font-weight: 600; }
.big-when { color: var(--faint); font-size: 12px; white-space: nowrap; }
.big-acts { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.big-act {
  display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 6px 0 3px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--muted-fg);
  font: inherit; font-size: 11.5px; cursor: pointer;
}
.big-act kbd { height: 14px; min-width: 14px; font-size: 10px; padding: 0 3px; background: var(--muted); }
.big-act:hover { color: var(--fg); border-color: var(--border-strong); }
.big-act[data-lead] { color: var(--fg); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.big-row.is-focus .big-act { color: var(--fg); }
.big-bar { display: block; height: 4px; border-radius: 999px; background: var(--muted); overflow: hidden; }
.big-fill { display: block; height: 100%; border-radius: inherit; background: var(--muted-fg); }
.big-fill[data-near] { background: var(--attn); }
${widths}
.big-word { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted-fg); white-space: nowrap; }
.big-word[data-word="working"], .big-word[data-word="autonomous"] { color: var(--accent); }
.big-word[data-word="queued"], .big-word[data-word="assisted"], .big-word[data-word="waiting"] { color: var(--muted-fg); }
.big-word[data-word="paused"], .big-word[data-word="stopped"], .big-word[data-word="failed"], .big-word[data-word="red"] { color: var(--attn); }
.big-word[data-word="look"], .big-word[data-word="green"], .big-word[data-word="shipped"], .big-word[data-word="ok"] { color: var(--success); }
.big-word[data-word="off"], .big-word[data-word="cancelled"] { color: var(--faint); }
.big-row .avatar { width: 20px; height: 20px; font-size: 9px; }

/* app rows: name · autonomy · working · asks · spend */
.big-row[data-kind="app"] { grid-template-columns: minmax(0, 1fr) 7em 5.5em 5.5em 9em; }
.big-row[data-kind="app"] .big-t { font-size: 13.5px; }
.big-row[data-kind="app"] .big-t small { color: var(--muted-fg); font-weight: 500; font-size: 12px; }
.big-n { font-family: var(--mono); font-size: 12px; color: var(--muted-fg); white-space: nowrap; }
.big-n b { color: var(--fg); font-weight: 600; }
.big-n[data-zero] { color: var(--faint); }
.big-n[data-hot] b { color: var(--accent); }
.big-spend { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; font-family: var(--mono); font-size: 11.5px; color: var(--muted-fg); }

/* run rows: who · title · elapsed · cost */
.big-row[data-kind="run"] { grid-template-columns: auto 6.5em minmax(0, 1fr) 6ch 6ch auto; }
.big-row[data-kind="run"] .big-t { grid-column: 3; }
.big-el { font-family: var(--mono); font-size: 12.5px; text-align: right; white-space: nowrap; }
.big-row[data-state="working"] .big-el { color: var(--accent); }
.big-row[data-state="queued"] .big-el, .big-row[data-state="paused"] .big-el { color: var(--faint); }
.big-cost { font-family: var(--mono); font-size: 12px; color: var(--muted-fg); text-align: right; white-space: nowrap; }

/* ask rows: mark · title + short · actions */
.big-row[data-kind="ask"] { grid-template-columns: 5.5em minmax(0, 1fr) auto; }
.big-row[data-kind="ask"] .big-m { grid-column: 2; }
.big-row[data-kind="ask"] .big-acts { grid-row: 1 / span 2; grid-column: 3; }
.big-row[data-kind="ask"] .big-word { grid-row: 1 / span 2; }

/* landed rows: title · who · when */
.big-row[data-kind="landed"] { grid-template-columns: minmax(0, 1fr) auto auto; }
/* decision rows: kind · answer · about · sure · outcome · when */
.big-row[data-kind="decision"] { grid-template-columns: 6em 5em minmax(0, 1fr) 4ch 5em auto; }
.big-row[data-kind="decision"] .big-p { font-family: var(--mono); font-size: 11.5px; color: var(--muted-fg); text-align: right; }
/* issue and pull rows: number · title · who · word · when */
.big-row[data-kind="issue"], .big-row[data-kind="pull"] { grid-template-columns: 4.5ch minmax(0, 1fr) auto auto auto; }
.big-num { font-family: var(--mono); font-size: 12px; color: var(--faint); }

/* ---- the glance: the focused app at a glance ---- */
.big-glance { display: flex; flex-direction: column; min-height: 0; }
.big-glance-dir { margin: 0; padding: 10px 12px 8px; font-size: 14px; font-weight: 550; letter-spacing: -0.01em; text-wrap: pretty; border-bottom: 1px solid var(--border); }
.big-glance-dir small { display: block; margin-top: 2px; font-size: 12px; font-weight: 500; color: var(--muted-fg); }
.big-sub { margin: 0; padding: 8px 12px 2px; font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
.big-glance-empty { display: grid; place-items: center; height: 100%; color: var(--faint); }

/* ---- the map inside a pane ---- */
.big-pane .map-canvas { border: 0; border-radius: 0; background: var(--card); flex: 1; min-height: 0; }
.big-pane .map-empty { border: 0; padding: 24px 12px; }
.big-pane .map-node.is-focus .map-card { stroke: var(--accent); stroke-width: 2; }
.big-pane .map-tools { display: none; }

/* ---- the lanes: the global map, one row per app ---- */
.big-lane { padding: 0; border-left-width: 2px; }
.big-lane .map-lane { border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.big-lane + .big-lane .map-lane { border-top: 1px solid var(--border); }
.big-lane .map-lane-head { padding: 8px 12px; }
.big-lane .map-lane-name { font-size: 13.5px; }
.big-lane .map-lane-head .map-counts { font-size: 11.5px; }

/* ---- the board's regions inside panes ---- */
.big-wall .board-region { padding: 8px 10px; }
.big-wall .board-h { position: static; padding: 0 0 6px; background: transparent; font-size: 11px; }
.big-wall .board-list { gap: 4px; }
.big-wall .board-card { padding: 7px 10px; border-color: transparent; border-radius: var(--radius-sm); background: transparent; outline: none; }
.big-wall .board-card:hover { border-color: var(--border); }
.big-wall .board-card.is-focus { background: color-mix(in srgb, var(--accent) 13%, transparent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.big-wall .board-run { padding: 7px 10px; }
.big-wall .board-run .avatar { width: 26px; height: 26px; font-size: 11px; margin-top: 1px; }
.big-wall .board-run-title { font-size: 1em; -webkit-line-clamp: 1; }
.big-wall .board-elapsed { font-size: 1.15em; }
.big-wall .board-run-meta, .big-wall .board-run-who { font-size: .92em; }
.big-wall .board-landed-title { font-size: 1em; }
.big-wall .board-thumb { width: 24px; height: 32px; }
.big-wall .board-landed .board-thumb img { width: 100%; height: 100%; }
.big-wall .board-app-name { font-size: 1em; }
.big-wall .board-quiet { padding: 4px 0; color: var(--faint); }

/* ---- the run: the transcript fills the pane ---- */
.big-run { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.big-run .run-live { margin: 0; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.big-run .run-log { flex: 1; min-height: 0; max-height: none !important; border: 0; border-radius: 0; background: transparent; font-size: 13px; padding: 8px 12px; }
.big-run .run-steer { border: 0; border-top: 1px solid var(--border); border-radius: 0; background: var(--card); padding: 8px 12px; }
.big-run .run-steer textarea { min-height: 32px; font-size: 13px; }
.big-run .run-actions { margin: 0; }
.big-run-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--muted-fg); }
.big-run-meta h1 { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
.big-run-meta .num { font-family: var(--mono); }
.big-run-meta .run-summary { flex-basis: 100%; margin: 0; font-size: 12.5px; color: var(--muted-fg); }

/* ---- the footer line ---- */
.big-foot { display: flex; align-items: center; gap: 4px 14px; padding: 0 12px; border-top: 1px solid var(--border); color: var(--muted-fg); font-size: 12px; white-space: nowrap; overflow: hidden; }
.big-key { display: inline-flex; align-items: center; gap: 3px; }
.big-key kbd + kbd { margin-left: -1px; }
.big-key kbd:last-of-type { margin-right: 3px; }
.big-foot .spacer { flex: 1; }
.big-foot .big-foot-view { color: var(--faint); font-family: var(--mono); font-size: 11.5px; }

/* ---- the line: command, filter, or a word to the crew ---- */
.big-line {
  position: fixed; left: var(--gap); right: var(--gap); bottom: var(--line); z-index: 5;
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  background: var(--card); border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border)); border-radius: var(--radius-sm);
  box-shadow: var(--shadow-2);
}
.big-line-mark { font-family: var(--mono); font-weight: 600; color: var(--accent); min-width: 1ch; }
.big-line[data-mode="say"] .big-line-mark { color: var(--success); }
.big-line-in { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--fg); font: inherit; font-family: var(--mono); font-size: 13px; outline: none; padding: 0; }
.big-line-note { font-size: 12px; color: var(--muted-fg); white-space: nowrap; }
.big-line-note[data-tone="danger"] { color: var(--danger); }

/* ---- the key sheet ---- */
.big-help { width: min(720px, 92vw); max-height: 86dvh; overflow: auto; }
.big-help h2 { font-size: 13px; margin: 0 0 8px; }
.big-help h2 + h2 { margin-top: 16px; }
.big-help table { width: 100%; border-collapse: collapse; }
.big-help td { padding: 4px 10px 4px 0; vertical-align: top; font-size: 13px; }
.big-help td:first-child { width: 12em; white-space: nowrap; }
.big-help kbd + kbd { margin-left: 3px; }
.big-help .big-cmd { font-family: var(--mono); color: var(--fg); }
.big-help .big-cmd i { color: var(--muted-fg); font-style: normal; }
.big-help .big-help-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; }
.big-help p { margin: 10px 0 0; color: var(--faint); font-size: 12px; }

/* ---- filtered away ---- */
.big [data-filtered] { display: none; }

/* ---- narrow: stacked, the body scrolls ---- */
@media (max-width: 899px) {
  .big { height: auto; min-height: 100dvh; grid-template-rows: var(--line) minmax(0, 1fr) var(--line); overflow: visible; }
  .big-body[data-layout] { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; }
  .big-pane { min-height: 220px; max-height: 60dvh; }
  .big-row[data-kind="app"] { grid-template-columns: minmax(0, 1fr) auto auto; }
  .big-row[data-kind="app"] .big-spend, .big-row[data-kind="app"] .big-word { display: none; }
  .big-row[data-kind="run"] { grid-template-columns: auto minmax(0, 1fr) auto; }
  .big-row[data-kind="run"] .big-t { grid-column: 2; }
  .big-row[data-kind="run"] .big-cost, .big-row[data-kind="run"] .big-word { display: none; }
  .big-row[data-kind="decision"] { grid-template-columns: 6em minmax(0, 1fr) auto; }
  .big-row[data-kind="decision"] .big-p, .big-row[data-kind="decision"] .big-when { display: none; }
  .big-foot { overflow: auto; }
  .big-foot .big-foot-view { display: none; }
}
@media (min-width: 1600px) { .big { font-size: 14px; } }
`;
