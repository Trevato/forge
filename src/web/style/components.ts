/**
 * The component vocabulary: one class per component, `data-*` for variants,
 * exactly as `docs/DESIGN.md` records it. Nothing here knows about a page —
 * if a rule mentions a page, it is in the wrong file.
 *
 * House rules enforced below: hairline borders only, two radii plus pills,
 * one accent (interaction) and semantic color only for meaning, transitions
 * ≤200ms on color/opacity/transform, tabular numerals wherever numbers align.
 */

export const components = /* css */ `
@layer components {

/* ---- icon slot ---- */
.ico {
  display: inline-flex; flex: none; width: 16px; height: 16px;
  align-items: center; justify-content: center; vertical-align: -0.15em;
}
/* The page's drawings, defined once each at the end of <body> (\`iconSprite\`,
   src/web/icons.ts). A <symbol> never renders where it is defined, but the
   <svg> holding them would take a line box, so it is taken out of flow. */
.sprite { position: absolute; width: 0; height: 0; overflow: hidden; }

/* ---- button ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 36px; padding: 0 12px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--card); color: var(--fg);
  font-weight: 500; font-size: 14px; white-space: nowrap; cursor: pointer;
  box-shadow: var(--shadow-1);
  transition: background-color 140ms var(--ease), border-color 140ms var(--ease),
    color 140ms var(--ease), opacity 140ms var(--ease);
}
.btn:hover { background: var(--muted); border-color: var(--border-strong); color: var(--fg); }
.btn:active { opacity: .85; }
.btn[disabled], .btn[aria-disabled="true"] { opacity: .5; pointer-events: none; }
.btn[aria-busy="true"] { opacity: .7; pointer-events: none; }
.btn[data-variant="primary"] {
  background: var(--primary); color: var(--primary-fg); border-color: var(--primary);
}
.btn[data-variant="primary"]:hover { opacity: .88; background: var(--primary); color: var(--primary-fg); }
.btn[data-variant="secondary"] { background: var(--muted); border-color: transparent; box-shadow: none; }
.btn[data-variant="secondary"]:hover { border-color: var(--border); }
.btn[data-variant="outline"] { background: transparent; box-shadow: none; }
.btn[data-variant="ghost"] { background: transparent; border-color: transparent; box-shadow: none; color: var(--muted-fg); }
.btn[data-variant="ghost"]:hover { background: var(--muted); color: var(--fg); border-color: transparent; }
/* A toggle shows its state: the chip, the sort button. */
.btn[aria-pressed="true"] { background: var(--muted); border-color: var(--border-strong); color: var(--fg); font-weight: 550; }
.btn[aria-pressed="false"] { color: var(--muted-fg); }
.btn[data-variant="danger"] { color: var(--danger); }
.btn[data-variant="danger"]:hover {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  background: color-mix(in srgb, var(--danger) 8%, var(--card));
  color: var(--danger);
}
.btn[data-variant="link"] {
  border-color: transparent; background: none; box-shadow: none;
  color: var(--accent); padding: 0; min-height: 0;
}
.btn[data-variant="link"]:hover { background: none; text-decoration: underline; text-underline-offset: 3px; }
.btn[data-size="sm"] { min-height: 28px; padding: 0 10px; font-size: 13px; gap: 5px; }
.btn[data-size="lg"] { min-height: 44px; padding: 0 18px; font-size: 15px; }
/* An icon button is a square of its size class — 36px matches the button min-height, so a row of mixed buttons has one silhouette. */
.btn-icon { padding: 0; width: 36px; min-width: 36px; }
.btn-icon[data-size="sm"] { width: 28px; min-width: 28px; }
.btn-icon[data-size="lg"] { width: 44px; min-width: 44px; }
/* Touch targets stay thumb-sized on a phone; padding does it, so text stays centered. */
@media (pointer: coarse) {
  .btn { min-height: 44px; }
  .btn[data-size="sm"] { min-height: 36px; }
  .btn-icon { width: 44px; min-width: 44px; }
  .btn-icon[data-size="sm"] { width: 36px; min-width: 36px; }
}

/* ---- form controls ---- */
.input {
  width: 100%; min-height: 36px; padding: 7px 10px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--card); color: var(--fg);
  transition: border-color 140ms var(--ease), box-shadow 140ms var(--ease);
}
.input:hover { border-color: var(--border-strong); }
.input:focus-visible {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.input[aria-invalid="true"], .input:user-invalid {
  border-color: var(--danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 14%, transparent);
}
.input[readonly] { background: var(--muted); color: var(--muted-fg); }
.input[data-size="sm"] { min-height: 28px; padding: 4px 8px; font-size: 13px; }
textarea.input {
  resize: vertical; min-height: 88px; line-height: 1.55; font-family: inherit;
  field-sizing: content; max-height: 24lh;
}
textarea.input[data-grow] { min-height: 5lh; }
select.input {
  appearance: none; padding-right: 28px; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
                    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: right 13px center, right 8px center;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
@media (pointer: coarse) { .input { min-height: 44px; } }
.bar .input[type=search] { min-width: 180px; flex: 1; max-width: 320px; }

/* One control for every boolean. A native checkbox tinted with accent-color
   is themed for free, keyboard-correct for free, and honest about what it is —
   a hand-built switch would be none of those. */
.check {
  display: inline-flex; align-items: flex-start; gap: 8px;
  font-weight: 400; font-size: 14px; cursor: pointer; margin: 0;
}
.check input { accent-color: var(--accent); margin-top: 2px; flex: none; }
/* A thumb needs a 44px target and a box it can see; in a table the bare
   check centres in its cell's target, so a miss does not tick the next one. */
@media (pointer: coarse) {
  .check { min-height: 44px; min-width: 44px; align-items: center; }
  .check input { width: 24px; height: 24px; margin: 0; }
  .table .check { justify-content: center; }
}

.field { display: block; margin: 0 0 16px; }
.field > label {
  display: block; font-size: 13px; font-weight: 550; margin: 0 0 6px; color: var(--fg);
}
.field .hint { display: block; font-size: 12.5px; color: var(--muted-fg); margin-top: 6px; }
.field .error { display: block; font-size: 12.5px; color: var(--danger); margin-top: 6px; font-weight: 500; }
.field[data-invalid] > label { color: var(--danger); }
/* A group of checks is one field: the legend reads as a label, no frame. */
fieldset.field { border: 0; padding: 0; min-width: 0; }
fieldset.field > legend {
  padding: 0; font-size: 13px; font-weight: 550; margin: 0 0 8px; color: var(--fg);
}
fieldset.field[data-invalid] > legend { color: var(--danger); }
fieldset.field > .check { display: flex; }
fieldset.field > .check + .check { margin-top: 8px; }
.field-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; }
.field-row .field { flex: 1; min-width: 160px; margin-bottom: 0; }
.form-actions { margin-top: 16px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* ---- stat tile ---- fixed heights: a changing value shifts nothing */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.stat {
  position: relative; display: block; box-sizing: border-box; height: 104px; padding: 10px 12px;
  overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--card); color: var(--fg); text-decoration: none;
}
@media (max-width: 480px) { .kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
a.stat:hover { border-color: var(--border-strong); }
.stat[data-tone="attn"] { border-color: color-mix(in srgb, var(--attn) 40%, var(--border)); }
.stat-label { display: block; height: 18px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-min); line-height: 18px; color: var(--muted-fg); }
.stat-value { display: block; height: 32px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 20px; font-weight: 600; line-height: 32px; }
.stat-note {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  height: 36px; font-size: var(--fs-min); line-height: 18px; color: var(--muted-fg);
}
.stat-spark { position: absolute; top: 10px; right: 12px; width: 56px; height: 24px; color: var(--muted-fg); }
.stat-spark svg { display: block; width: 100%; height: 100%; }

/* ---- badge / label chip / pill / dot ---- */
.badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px;
  border: 1px solid var(--border); border-radius: 999px;
  font-size: var(--fs-min); font-weight: 500; line-height: 18px; color: var(--muted-fg);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.badge[data-variant="secondary"] { background: var(--muted); border-color: transparent; }
.badge[data-variant="outline"] { background: none; }
.badge[data-variant="success"], .badge[data-state="open"] {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 34%, transparent);
  background: color-mix(in srgb, var(--success) 12%, transparent);
}
.badge[data-variant="danger"], .badge[data-state="closed"] {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 34%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
.badge[data-variant="merged"], .badge[data-pr="merged"] {
  color: var(--merged);
  border-color: color-mix(in srgb, var(--merged) 34%, transparent);
  background: color-mix(in srgb, var(--merged) 12%, transparent);
}
.badge[data-variant="attn"] {
  color: var(--attn);
  border-color: color-mix(in srgb, var(--attn) 34%, transparent);
  background: color-mix(in srgb, var(--attn) 12%, transparent);
}
.badge .ico { width: 12px; height: 12px; }
/* A loader that turns: the one icon that means "still going". */
.ico-loader { animation: spin 1.1s linear infinite; }
/* A button never spins at rest: only its own busy state turns the loader. */
.btn .ico-loader { animation-play-state: paused; }
.btn[aria-busy="true"] .ico-loader { animation-play-state: running; }
@keyframes spin { to { transform: rotate(360deg); } }

/* One stored hex, derived three ways, so a chip reads correctly in all six
   themes. --label is set by a per-page nonce'd rule; the hex is validated
   before it is ever embedded. */
.label {
  --label: var(--muted-fg);
  display: inline-flex; align-items: center; padding: 0 8px;
  border-radius: 999px; font-size: var(--fs-min); font-weight: 500; line-height: 18px;
  color: color-mix(in srgb, var(--label) 78%, var(--fg));
  background: color-mix(in srgb, var(--label) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--label) 32%, transparent);
  white-space: nowrap;
}
a.label:hover { color: color-mix(in srgb, var(--label) 90%, var(--fg)); }

.pill {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; padding: 0 6px; border-radius: 999px;
  background: var(--muted); color: var(--muted-fg);
  font-size: var(--fs-min); font-weight: 550; line-height: 18px;
  font-variant-numeric: tabular-nums;
}
.pill[data-tone="accent"] { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.pill[data-tone="danger"] { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }

progress { display: block; width: 100%; height: 4px; margin: 6px 0; appearance: none; border: 0; border-radius: var(--radius-sm); background: var(--border); overflow: hidden; }
progress::-webkit-progress-bar { background: var(--border); }
progress::-webkit-progress-value { background: var(--success); }
progress::-moz-progress-bar { background: var(--success); }

.dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: var(--faint); flex: none; }
.word-text { font-weight: 600; color: var(--fg); }
.dot[data-tone="success"] { background: var(--success); }
.dot[data-tone="danger"] { background: var(--danger); }
.dot[data-tone="attn"] { background: var(--attn); }
.dot[data-tone="merged"] { background: var(--merged); }
.dot[data-series="0"] { background: var(--series-0); }
.dot[data-series="1"] { background: var(--series-1); }
.dot[data-series="2"] { background: var(--series-2); }
.dot[data-series="3"] { background: var(--series-3); }
.dot[data-series="4"] { background: var(--series-4); }
.dot[data-series="5"] { background: var(--series-5); }
.dot[data-series="6"] { background: var(--series-6); }
.dot[data-series="7"] { background: var(--series-7); }

/* ---- stacked bar chart: series stacked per bucket, drawn as SVG on the server ---- */
.plots { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 16px; margin: 0 0 16px; }
.plots figcaption { font-size: 13px; font-weight: 600; margin: 0 0 4px; display: flex; gap: 8px; align-items: baseline; }
.plot { display: block; width: 100%; height: auto; }
.plot line { stroke: var(--border); stroke-width: 1; }
.plot text { fill: var(--muted-fg); font-family: var(--mono); }
.plot .plot-name text { fill: var(--faint); font-family: inherit; }
.plot-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 12px; font-size: 13px; }
.plot-legend li { display: inline-flex; align-items: center; gap: 6px; }

/* ---- meter: a share as a bar — spend against a ceiling, a window used, how sure ---- */
meter {
  display: block; width: 100%; height: 6px; appearance: none;
  background: var(--muted); border: 0; border-radius: 999px; overflow: hidden;
}
meter::-webkit-meter-bar { height: 6px; background: var(--muted); border: 0; border-radius: 999px; }
meter::-webkit-meter-optimum-value, meter::-webkit-meter-suboptimum-value, meter::-webkit-meter-even-less-good-value { background: var(--muted-fg); border-radius: 999px; }
meter::-moz-meter-bar { background: var(--muted-fg); border-radius: 999px; }
meter[data-tone="attn"]::-webkit-meter-optimum-value, meter[data-tone="attn"]::-webkit-meter-suboptimum-value, meter[data-tone="attn"]::-webkit-meter-even-less-good-value { background: var(--attn); }
meter[data-tone="attn"]::-moz-meter-bar { background: var(--attn); }

kbd {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 5px;
  border: 1px solid var(--border); border-bottom-width: 2px;
  border-radius: var(--radius-sm); background: var(--muted);
  font-family: var(--mono); font-size: var(--fs-min); font-weight: 500; color: var(--muted-fg);
}

/* A menu or palette row's key sits in its own column (#8930); anywhere else a
   key is a tooltip or an overlay and takes no room. */
.keyhint { margin-left: 6px; }
@media (pointer: coarse), (max-width: 640px) { .keyhint { display: none; } }

/* ::before, because components already use ::after (the current tab's line,
   a menu's caret). :where() keeps the host rule at zero specificity, so a
   component that positions itself (sticky, absolute) keeps its position. The
   text after "/" is the chip's accessible text: none, so a name is never read
   with its key glued on; the key is \`aria-keyshortcuts\` instead. */
:where([data-hint]) { position: relative; }
[data-hint]::before {
  content: attr(data-hint); content: attr(data-hint) / ""; position: absolute; z-index: 40;
  top: calc(100% + 4px); left: 50%; transform: translateX(-50%);
  min-width: 20px; padding: 2px 5px; box-sizing: border-box; text-align: center;
  border: 1px solid var(--border); border-bottom-width: 2px;
  border-radius: var(--radius-sm); background: var(--muted); color: var(--muted-fg);
  font-family: var(--mono); font-size: var(--fs-min); font-weight: 500; line-height: 16px; white-space: nowrap;
  opacity: 0; pointer-events: none; transition: opacity 120ms var(--ease);
}
@media (hover: hover) and (pointer: fine) {
  [data-hint]:hover::before, [data-hint]:focus-visible::before, [data-hint]:focus-within::before,
  html[data-hints] [data-hint]::before { opacity: 1; }
}
/* At the window's edges the chip hangs inward, so it never leaves the viewport. */
.wordmark[data-hint]::before { left: 0; transform: none; }
.topbar-tools [data-hint]::before { left: auto; right: 0; transform: none; }
/* A card clips what leaves its box: there the chip sits on the element's top
   right corner, mostly above it, clear of the label's text. */
.card [data-hint]::before { top: 0; left: auto; right: 0; transform: translateY(-60%); }
/* The tab strip scrolls sideways, so it clips above and below too: the chip is
   small and sits in the tab's own top padding, above the label. */
.tabs [data-hint]::before {
  top: 0; min-width: 0; padding: 0 3px; border-bottom-width: 1px; line-height: 12px;
}
@media (pointer: coarse) { [data-hint]::before { display: none; } }

.sha {
  font-family: var(--mono); font-size: 12.5px; padding: 1px 5px;
  border-radius: 4px; background: var(--muted); color: var(--muted-fg);
  font-variant-numeric: tabular-nums;
}
a.sha:hover { color: var(--accent); }

/* ---- avatar ----
   The hue is the person's (data-h, twelve of them), so the twelve are spelled
   here as oklch values (the HSL colours they were, 62% saturation at 52% and
   42% lightness), not palette tokens; the 20px and 16px circles' initials sit
   below the type scale on purpose, in rem so the scale check does not see them.
   The default is the old fallback, hsl(220 62% 52%), which is oklch hue 262. The
   initials are 28% ink and 72% --fg: that keeps 4.5:1 on the tinted circle in
   every theme (the old 88% ink did not, and no single ink can in both a light
   and a dark theme), so the hue is carried by the circle and its ring. */
.avatar {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 20px; height: 20px; border-radius: 999px;
  --av: oklch(54.9% 0.166 262); --av-ink: oklch(47.0% 0.150 262);
  background: color-mix(in srgb, var(--av) 22%, var(--card));
  color: color-mix(in srgb, var(--av-ink) 28%, var(--fg));
  border: 1px solid color-mix(in srgb, var(--av) 30%, transparent);
  font-size: var(--fs-min); font-weight: 650; letter-spacing: 0; text-transform: uppercase;
  user-select: none;
}
.avatar[data-h="0"] { --av: oklch(59.5% 0.170 31); --av-ink: oklch(51.3% 0.154 31); }
.avatar[data-h="1"] { --av: oklch(71.9% 0.128 77); --av-ink: oklch(62.3% 0.114 77); }
.avatar[data-h="2"] { --av: oklch(81.7% 0.170 117); --av-ink: oklch(71.2% 0.151 117); }
.avatar[data-h="3"] { --av: oklch(77.1% 0.205 137); --av-ink: oklch(67.1% 0.183 137); }
.avatar[data-h="4"] { --av: oklch(75.5% 0.214 145); --av-ink: oklch(65.7% 0.191 145); }
.avatar[data-h="5"] { --av: oklch(76.7% 0.149 164); --av-ink: oklch(66.8% 0.133 163); }
.avatar[data-h="6"] { --av: oklch(73.5% 0.113 210); --av-ink: oklch(63.8% 0.100 210); }
.avatar[data-h="7"] { --av: oklch(56.0% 0.160 261); --av-ink: oklch(47.9% 0.145 261); }
.avatar[data-h="8"] { --av: oklch(47.1% 0.220 280); --av-ink: oklch(40.1% 0.197 279); }
.avatar[data-h="9"] { --av: oklch(55.0% 0.224 310); --av-ink: oklch(47.3% 0.200 309); }
.avatar[data-h="10"] { --av: oklch(61.6% 0.231 334); --av-ink: oklch(53.3% 0.206 334); }
.avatar[data-h="11"] { --av: oklch(58.5% 0.192 3); --av-ink: oklch(50.5% 0.171 4); }
.avatar[data-size="md"] { width: 28px; height: 28px; font-size: 12.5px; }
.avatar[data-size="lg"] { width: 56px; height: 56px; font-size: 20px; border-radius: var(--radius-lg); }

.byline { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.byline a:hover { color: var(--accent); }
.name-mark {
  display: inline-block; padding: 0 5px; border-radius: 4px;
  font-size: var(--fs-min); font-weight: 600; line-height: 15px; letter-spacing: 0.04em;
  text-transform: uppercase; white-space: nowrap; vertical-align: 1px;
  color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.name-mark[data-mark="crew"] { color: var(--muted-fg); background: var(--muted); }

/* ---- card ---- */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  overflow: clip;
}
/* Cards stacked in normal flow space themselves. Inside a container that
   already manages its own spacing with gap, that margin would double it. */
.card + .card { margin-top: 12px; }
/* The open pulls a held issue waits on: a wrapping line of touch-sized links. */
.held-pulls { display: flex; flex-wrap: wrap; gap: 0 4px; align-items: center; }
.held-pulls a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 8px; }
:is(.stack, .split, .timeline) > .card + .card { margin-top: 0; }
.card-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--muted);
}
.card-head h2, .card-head h3 { margin: 0; }
/* A card head's links: spaced apart, and each a 44px target on a thumb. */
.card-links { display: inline-flex; align-items: center; gap: 10px; }
.card-links > a { color: inherit; }
@media (pointer: coarse) { .card-links { gap: 0; } .card-links > a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 8px; } }
.card-body { padding: 14px; }
.card-foot {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 14px; border-top: 1px solid var(--border); background: var(--muted);
}
.card[data-tone="success"] { border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }
.card[data-tone="danger"] { border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.card[data-tone="merged"] { border-color: color-mix(in srgb, var(--merged) 40%, var(--border)); }
.card[data-tone="attn"] { border-color: color-mix(in srgb, var(--attn) 40%, var(--border)); }

/* ---- look: a picture the forge took, in a hairline frame ----
   A strip sets a phone beside a desktop: the phone keeps a phone's
   narrowness, the desktop takes what is left, never more than its own size;
   under 640px they stack. data-compare sets two sides (before, after) beside
   each other instead. A thumb shows the top of the picture; now is
   production small. */
.look { display: block; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--muted); }
.look img { display: block; width: 100%; height: auto; }
.look[data-slot="thumb"] { flex: none; width: 30px; height: 40px; border-radius: 4px; }
.look[data-slot="thumb"] img { height: 100%; object-fit: cover; object-position: top; }
.look[data-slot="feed"] { width: 160px; height: 100px; margin-top: 6px; }
.look[data-slot="feed"] img { height: 100%; object-fit: cover; object-position: top; }
.look[data-slot="now"] { flex: none; width: 168px; }
.looks { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
.looks > [data-slot="phone"] { flex: 0 0 200px; }
.looks > [data-slot="desktop"] { flex: 1 1 320px; min-width: 0; max-width: 1280px; }
.looks > figure { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.looks[data-compare] { gap: 20px; }
.looks[data-compare] > * { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
@media (max-width: 640px) {
  .looks:not([data-compare]):not([data-look] .looks) { flex-direction: column; }
  .looks > [data-slot="phone"] { flex-basis: auto; width: 200px; }
}

/* ---- list rows ---- */
.list > li + li { border-top: 1px solid var(--border); }
.row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 14px; min-height: 40px;
  transition: background-color 100ms var(--ease);
}
a.flow-row { min-height: 44px; }
.row:focus-visible { outline-offset: -2px; }
a.row:hover, .row[data-nav]:hover { background: var(--muted); color: inherit; }
.list li[aria-current="true"] > .row { background: var(--muted); }
/* A tree: the rows under a row hang from a rule, a step in. */
.row-children { list-style: none; margin: 0 0 0 22px; padding: 0; border-left: 1px solid var(--border); }
.row-children > li { border-top: 1px solid var(--border); }
@media (max-width: 719px) { .row-children { margin-left: 12px; } }
/* A row's look thumbs (/review): inset like a row, side by side at any width; the link's hit area grows to 44px. */
.row-children > [data-look] { padding: 8px 14px; }
[data-look] .looks { flex-wrap: nowrap; gap: 10px; align-items: center; }
[data-look] a.look { position: relative; overflow: visible; }
[data-look] a.look::after { content: ""; position: absolute; inset: -7px; }
a.row:hover .row-title { color: var(--accent); }
.row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.row-title {
  font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: color 100ms var(--ease);
}
/* One honest line: everything in it is inline, so text-overflow actually
   has a block box to ellipsize (a flex container would silently ignore it)
   and nothing can wrap out from under the row's padding. */
.row-meta {
  display: block; font-size: 12.5px; color: var(--muted-fg); line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.row-meta .byline { display: inline; }
.row-meta .avatar { width: 16px; height: 16px; font-size: var(--fs-min); vertical-align: -0.28em; }
.row-meta .byline-name { margin-left: 4px; }
.row-lead { color: var(--faint); display: inline-flex; flex: none; }
/* A control beside a link row, outside the link: the row takes the width, the control keeps its own. */
.list > li.has-after { display: flex; align-items: center; flex-wrap: wrap; }
.list > li.has-after > .row, .list > li.has-after > details { flex: 1 1 0; min-width: 0; }
.row-after { flex: none; padding: 0 14px 0 0; }
.list > li.has-after > .row-children { flex-basis: 100%; }
.archived-list .row-title, .archived-list .row-meta { white-space: normal; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .archived-list .list > li.has-after > .row { flex-basis: 100%; }
  .archived-list .row-after { width: 100%; display: flex; justify-content: flex-end; gap: 8px; padding: 0 14px 10px; }
}
.row-trail { display: flex; align-items: center; gap: 8px; flex: none; }
/* The leading glyph is the row's state; a badge repeating it is noise. */
.row[data-state="open"] .row-lead { color: var(--success); }
.row[data-state="closed"] .row-lead { color: var(--danger); }
.row[data-state="merged"] .row-lead { color: var(--merged); }
.row[data-state="draft"] .row-lead { color: var(--muted-fg); }
/* A row that folds is a <summary>: its lead is the caret, turned when open. */
summary.row { cursor: pointer; list-style: none; }
summary.row:hover { background: var(--muted); }
details[open] > summary.row > .row-lead { transform: rotate(90deg); }
/* A count with its glyph: comments on a row, members on a team. */
.count {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12.5px; color: var(--muted-fg); font-variant-numeric: tabular-nums;
}
.count .ico { width: 14px; height: 14px; }
/* A group of them — issues and pulls on a repo row, in one muted cluster. */
.counts { display: inline-flex; align-items: center; gap: 10px; flex: none; }
/* Secondary actions are always in the DOM, revealed without layout shift. */
.row-actions { opacity: 0; transition: opacity 120ms var(--ease); }
.row:hover .row-actions, .row:focus-within .row-actions { opacity: 1; }
/* Settings controls are the point of their row, never revealed by hover:
   they wrap under the text before they would clip, at any width. */
.row-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.row-fields .input { min-width: 0; max-width: 100%; }
/* A number beside its label in a settings row stays a few digits wide. */
.row-fields .input[type="number"] { width: 5em; }
.row-fields .check { align-items: center; }
.setting-list .row { flex-wrap: wrap; align-items: flex-start; }
.setting-list .row-main { flex: 1 1 18rem; }
.setting-list .row-title, .setting-list .row-meta { white-space: normal; overflow: visible; overflow-wrap: anywhere; }
.setting-list .record-value { user-select: all; }
.setting-list .row-trail { flex: 0 1 auto; max-width: 100%; }
@media (max-width: 640px) { .setting-list .row-trail { flex-basis: 100%; } }
@media (pointer: coarse) { .row-actions { opacity: 1; } .row { min-height: 44px; } }
.row[data-state="closed"] .row-title, .row[data-state="merged"] .row-title { color: var(--muted-fg); }

/* ---- edit row: a list row whose body is a small form ---- */
.edit-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 14px;
}
.edit-row > .preview { flex: none; }
.edit-row > .input { flex: 1 1 160px; width: auto; min-width: 0; }
.edit-row .btn { flex: none; }
.edit-row .label-open { color: var(--muted-fg); font-size: 13px; text-decoration: underline; text-underline-offset: 2px; }
.edit-row .label-open:hover { color: var(--fg); }
/* A swatch and its hex, as one control-shaped thing. */
.color-field {
  display: inline-flex; align-items: center; gap: 8px; flex: none;
  min-height: 36px; padding: 0 10px 0 4px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--card);
}
.color-field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.color-field input[type="color"] {
  appearance: none; -webkit-appearance: none; flex: none;
  width: 26px; height: 26px; padding: 0; border: 0; border-radius: 999px;
  background: none; cursor: pointer;
}
.color-field input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
.color-field input[type="color"]::-webkit-color-swatch { border: 1px solid var(--border-strong); border-radius: 999px; }
.color-field input[type="color"]::-moz-color-swatch { border: 1px solid var(--border-strong); border-radius: 999px; }
@media (pointer: coarse) { .color-field { min-height: 44px; } }
@media (max-width: 719px) {
  .edit-row { align-items: stretch; }
  .edit-row > .input { flex-basis: 100%; }
  .edit-row .color-field, .edit-row .btn { flex: 1 1 auto; justify-content: center; }
  .edit-row .label-open { display: inline-flex; align-items: center; min-height: 44px; padding: 0 8px; }
}

/* ---- table ---- */
.table { width: 100%; font-size: 13px; }
.table th {
  text-align: left; font-weight: 550; font-size: 12.5px; color: var(--muted-fg);
  padding: 8px 12px; border-bottom: 1px solid var(--border); white-space: nowrap;
}
.table td {
  padding: 9px 12px; border-top: 1px solid var(--border);
  font-variant-numeric: tabular-nums; vertical-align: middle;
}
.table tbody tr:first-child td { border-top: none; }
.table[data-dense] td, .table[data-dense] th { padding: 5px 10px; }
.table .num { text-align: right; }
.table-scroll { overflow-x: auto; scrollbar-width: thin; }
/* The row's name stays in view while a narrow screen scrolls the figures. */
.table[data-sticky-lead] th:first-child,
.table[data-sticky-lead] td:first-child {
  position: sticky; left: 0; z-index: 1; background: var(--card);
}

/* A sub-row (data-sub) is a split of the row above: indented under it, its
   label cut with an ellipsis so a long "model · prompt" cannot widen the
   sticky lead cell past a phone's width. */
.table tr[data-sub] td:first-child {
  padding-left: 24px; max-width: 14rem;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ---- tabs (navigation links, never role=tab) ---- */
.tabs {
  min-width: 0; max-width: 100%; display: flex; gap: 2px; align-items: stretch;
  border-bottom: 1px solid var(--border);
  overflow-x: auto; scrollbar-width: none;
  scroll-snap-type: x proximity;
  mask-image: linear-gradient(90deg, var(--fg) 0 calc(100% - 20px), transparent);
}
.tabs::-webkit-scrollbar { display: none; }
.tabs > a {
  position: relative; display: inline-flex; align-items: center; gap: 6px;
  padding: 0 12px; min-height: 40px; white-space: nowrap;
  scroll-snap-align: start;
  color: var(--muted-fg); font-size: 14px;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  transition: color 120ms var(--ease), background-color 120ms var(--ease);
}
.tabs > a:hover { color: var(--fg); background: var(--muted); }
.tabs > a[aria-current="page"] { color: var(--fg); font-weight: 550; }
.tabs > a[aria-current="page"]::after {
  content: ""; position: absolute; left: 8px; right: 8px; bottom: -1px;
  top: calc(100% - 1px); border-radius: 2px 2px 0 0; background: var(--fg);
}
@media (min-width: 720px) { .tabs { mask-image: none; } }

/* ---- segmented control (radios in a GET form, or links) ---- */
.seg {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
  padding: 2px; background: var(--muted); border-radius: var(--radius);
  max-width: 100%; overflow-x: auto; scrollbar-width: none;
}
@media (max-width: 420px) { .seg > a, .seg > label { padding: 0 8px; } }
.seg > a, .seg > label {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 28px; padding: 0 10px; border-radius: var(--radius-sm);
  font-size: 13px; font-weight: 500; color: var(--muted-fg);
  white-space: nowrap; cursor: pointer; margin: 0;
  transition: background-color 120ms var(--ease), color 120ms var(--ease);
}
.seg > a:hover, .seg > label:hover { color: var(--fg); }
.seg > label input { position: absolute; opacity: 0; pointer-events: none; }
.seg > a[aria-current="page"], .seg > label:has(input:checked) {
  background: var(--card); color: var(--fg); box-shadow: var(--shadow-1);
}
.seg > label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
@media (pointer: coarse) { .seg > a, .seg > label { min-height: 36px; } }

/* ---- menu (details; correct with zero JavaScript) ---- */
.menu { position: relative; flex: none; }
.menu > summary { list-style: none; }
.menu > summary::after {
  content: ""; width: 0; height: 0; margin-left: 2px;
  border: 3.5px solid transparent; border-top-color: currentColor;
  opacity: .55; transform: translateY(2px);
  transition: transform 160ms var(--ease);
}
.menu[open] > summary::after { transform: translateY(-1px) rotate(180deg); }
.menu > summary.btn-icon::after, .menu > summary[data-caret="none"]::after { content: none; }
.menu-panel {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 30;
  min-width: 220px; max-width: min(320px, calc(100vw - 32px)); padding: 5px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-2);
  animation: pop 140ms var(--ease) both;
  max-height: min(70vh, 480px); overflow-y: auto; scrollbar-width: none;
}
.menu[data-align="start"] > .menu-panel { right: auto; left: 0; }
@keyframes pop { from { opacity: 0; transform: translateY(-4px); } }
.menu-title {
  display: block; padding: 6px 10px 4px;
  font-size: var(--fs-min); font-weight: 600; letter-spacing: .08em;
  text-transform: uppercase; color: var(--faint);
}
.menu-item {
  display: flex; width: 100%; align-items: center; gap: 8px;
  padding: 7px 10px; border: 0; border-radius: var(--radius-sm);
  background: none; color: var(--fg); font-size: 14px;
  text-align: left; cursor: pointer;
  transition: background-color 100ms var(--ease);
}
.menu-item:hover, .menu-item:focus-visible { background: var(--muted); color: var(--fg); }
.menu-item[aria-current="true"] { font-weight: 550; }
.menu-item[aria-disabled="true"] { cursor: not-allowed; opacity: .65; }
.menu-item[aria-disabled="true"]:hover { background: none; }
.menu-item small { display: block; }
.menu-item[aria-disabled="true"] .grow { white-space: normal; }
.menu-item .ico { color: var(--faint); }
.menu-item .grow { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-sep { border: 0; border-top: 1px solid var(--border); margin: 5px 4px; }
/* No anchor positioning: browsers that accept anchor-name but not
   position-area would keep position: fixed and park the panel at the
   viewport's corner. Absolute-inside-the-details works everywhere. */

/* ---- disclosure: what a person sometimes needs, closed until asked for ---- */
.disclosure > summary {
  cursor: pointer; font-weight: 560; list-style: none; color: var(--muted-fg);
  display: flex; align-items: center; gap: 6px; padding: 6px 0; min-height: 44px;
}
.disclosure > summary::-webkit-details-marker { display: none; }
.disclosure > summary::before {
  content: "›"; display: inline-block; color: var(--faint);
  transition: transform 120ms var(--ease);
}
.disclosure[open] > summary::before { transform: rotate(90deg); }
.disclosure > summary:hover { color: var(--accent); }

/* ---- topbar search (always a real form, so JS-off still searches) ---- */
.topbar-search {
  display: flex; align-items: center; gap: 6px;
  min-width: 0; width: clamp(140px, 22vw, 240px);
  padding: 0 8px; min-height: 32px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--card); color: var(--muted-fg);
  transition: border-color 140ms var(--ease);
}
.topbar-search:focus-within { border-color: var(--accent); }
.topbar-search input {
  flex: 1; min-width: 0; border: 0; background: none; outline: none;
  font-size: 16px; color: var(--fg);
}
.topbar-search kbd { flex: none; }

/* ---- theme swatch: the colour chip beside each theme in the menu's picker ---- */
.swatch {
  display: inline-block; flex: none; position: relative;
  width: 20px; height: 20px; border-radius: 999px;
  border: 1px solid var(--border-strong);
}
.swatch::after { content: ""; position: absolute; inset: 6px; border-radius: 999px; }

/* ---- dialog (progressive: every dialog has a real page behind it) ---- */
.dialog {
  /* The reset zeroes every margin, which takes away the UA's margin: auto
     that centres a top-layer dialog — so a dialog must say so itself. */
  margin: auto;
  width: min(560px, calc(100vw - 32px)); padding: 0;
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--card); color: var(--fg);
  box-shadow: var(--shadow-2);
}
.dialog::backdrop { background: color-mix(in srgb, var(--bg) 62%, #0008); backdrop-filter: blur(3px); }
.dialog[open] { animation: pop 140ms var(--ease) both; }
.dialog-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 0; }
.dialog-head h2 { flex: 1; }
.dialog-body { padding: 12px 16px; }
.dialog-foot { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px 16px; }
.dialog[data-side="bottom"] {
  width: 100%; max-width: 100%; margin: auto auto 0;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0; border-bottom: 0;
}
@media (max-width: 719px) {
  .dialog { width: 100%; max-width: 100%; margin: auto auto 0; border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
}

/* ---- tell the crew, in place: fixed, so nothing shifts ---- */
.tell-here { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; width: min(620px, 100%); margin: 0 auto; padding: 8px; }
.tell-picture { max-width: 100%; height: auto; }
.tell-here .comment-form { margin: 0; box-shadow: var(--shadow-2); }

/* ---- command palette ---- */
/* A dialog centres itself with its own auto margins, which the reset zeroes
   — so anything that wants to be centred has to say so again. */
.palette { width: min(620px, calc(100vw - 24px)); margin: 12dvh auto auto; }
@media (max-width: 719px) {
  .palette { width: 100%; max-width: 100%; margin: auto auto 0; }
}
.palette .palette-input {
  width: 100%; border: 0; border-bottom: 1px solid var(--border); border-radius: 0;
  min-height: 48px; padding: 0 16px; background: none; font-size: 15px; box-shadow: none;
}
.palette .palette-input:focus-visible { box-shadow: none; border-color: var(--border); }
/* A height, not a ceiling: the dialog must not jump as rows come and go
   under a query. */
.palette-list {
  height: min(46dvh, 420px); overflow-y: auto; overscroll-behavior: contain;
  padding: 6px; scrollbar-width: thin;
}
.palette-group + .palette-group { margin-top: 4px; }
.palette-heading {
  padding: 8px 10px 4px;
  font-size: var(--fs-min); font-weight: 600; letter-spacing: .08em;
  text-transform: uppercase; color: var(--faint);
}
.palette-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 10px; border: 0; border-radius: var(--radius-sm);
  background: none; color: var(--fg); font-size: 14px; text-align: left;
  text-decoration: none; cursor: pointer;
}
.palette-item .grow { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette-item .ico { color: var(--faint); }
.palette-item .cat {
  flex: none; max-width: 45%; margin-left: auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12.5px; color: var(--faint);
}
/* One highlight. The pointer moves it (the script listens) rather than
   painting a second one under the cursor; the finder keeps plain hover. */
.palette-item[aria-selected="true"], .finder .palette-item:hover { background: var(--muted); }
.palette-foot {
  display: flex; align-items: center; gap: 10px; padding: 8px 14px;
  border-top: 1px solid var(--border); font-size: 12.5px; color: var(--faint);
}
.palette-empty {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  height: 100%; margin: 0; color: var(--muted-fg); font-size: 13px; text-align: center;
}

/* ---- toast / flash ---- */
.toast {
  display: flex; align-items: flex-start; gap: 8px;
  margin: 16px 0 0; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--card); box-shadow: var(--shadow-1);
  font-size: 14px;
  animation: pop 160ms var(--ease) both;
}
.toast .ico { margin-top: 1px; }
.toast[data-tone="success"] {
  border-color: color-mix(in srgb, var(--success) 34%, transparent);
  background: color-mix(in srgb, var(--success) 8%, var(--card));
}
.toast[data-tone="success"] .ico { color: var(--success); }
.toast[data-tone="danger"] {
  border-color: color-mix(in srgb, var(--danger) 34%, transparent);
  background: color-mix(in srgb, var(--danger) 8%, var(--card));
}
.toast[data-tone="danger"] .ico { color: var(--danger); }
.toast[data-tone="attn"] {
  border-color: color-mix(in srgb, var(--attn) 34%, transparent);
  background: color-mix(in srgb, var(--attn) 8%, var(--card));
}
.toast[data-tone="attn"] .ico { color: var(--attn); }
.toast .toast-body { flex: 1; min-width: 0; }
.toast code { display: block; margin-top: 6px; }

/* ---- tooltip ---- */
[data-tip] { position: relative; }
[data-tip]::after {
  content: attr(data-tip); position: absolute; z-index: 40;
  bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
  padding: 4px 8px; border-radius: var(--radius-sm);
  background: var(--primary); color: var(--primary-fg);
  font-size: 12.5px; font-weight: 500; white-space: nowrap;
  opacity: 0; pointer-events: none; transition: opacity 120ms var(--ease);
}
[data-tip][data-tip-side="bottom"]::after { bottom: auto; top: calc(100% + 6px); }
[data-tip]:hover::after, [data-tip]:focus-visible::after { opacity: 1; }
@media (pointer: coarse) { [data-tip]::after { display: none; } }

/* ---- page head: title, actions, subtitle ---- */
.page-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 20px 0 14px;
}
.page-head h1 { min-width: 0; overflow-wrap: anywhere; }
.page-head > .page-head-sub { flex-basis: 100%; margin-top: -4px; }

/* ---- breadcrumbs ---- */
.crumbs {
  display: flex; align-items: center; gap: 4px; min-width: 0;
  font-size: 14px; overflow: hidden;
}
.crumbs a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* On a phone the crumbs would be squeezed to "y… / c."; the page header
   right below says where you are, in full. */
@media (max-width: 719px) { .topbar .crumbs { display: none; } }
/* The dot between facts on a line (a where strip, a row's meta); the crumbs
   keep their own for the flex rule. */
.sep { color: var(--faint); }
.row-meta .sep { margin: 0 3px; }
.crumbs .sep { color: var(--faint); flex: none; }
.crumbs [aria-current="page"] { font-weight: 550; }
.crumbs.mono, .crumbs.mono a { font-family: var(--mono); font-size: 12.5px; }

/* ---- pagination ---- */
.pager {
  display: flex; align-items: center; gap: 8px; justify-content: center;
  margin-top: 12px; font-size: 13px; color: var(--muted-fg);
}
.pager .spacer { flex: 1; }

/* ---- timeline ---- */
.timeline { position: relative; display: flex; flex-direction: column; gap: 12px; }
.timeline::before {
  content: ""; position: absolute; left: 13px; top: 8px; bottom: 8px;
  width: 2px; background: var(--border);
}
.tl-item { position: relative; padding-left: 36px; min-width: 0; }
.tl-item .tl-dot {
  position: absolute; left: 4px; top: 6px;
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 999px;
  background: var(--muted); border: 1px solid var(--border); color: var(--muted-fg);
}
.tl-item[data-tone="success"] .tl-dot { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }
.tl-item[data-tone="danger"] .tl-dot { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.tl-item[data-tone="merged"] .tl-dot { color: var(--merged); border-color: color-mix(in srgb, var(--merged) 40%, var(--border)); }
.tl-item[data-kind="event"] {
  font-size: 13px; color: var(--muted-fg);
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  min-height: 32px;
}
.tl-earlier { margin: 0; padding-left: 36px; color: var(--muted-fg); font-size: 13px; }
.tl-item[data-kind="comment"] .card { margin: 0; }
.tl-item[data-kind="event"] > .card { flex-basis: 100%; margin: 4px 0 0; color: var(--fg); font-size: 14px; }
.tl-item[data-kind="event"] > .card .comment-body { padding: 8px 12px; }

/* ---- comment card ---- */
.comment .card-head { background: var(--muted); font-size: 13px; }
.comment .comment-body { padding: 2px 16px 8px; }
.comment-form { margin-top: 16px; padding: 12px; overflow: visible; }
.comment-form textarea { margin-bottom: 10px; }

/* ---- empty state ---- */
.empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 48px 20px; text-align: center; color: var(--muted-fg);
}
.empty .ico { color: var(--faint); width: 20px; height: 20px; }
.empty h2, .empty .empty-title {
  font-size: 15px; font-weight: 600; color: var(--fg); text-wrap: balance; margin: 0;
  overflow-wrap: anywhere;
}
.empty p { font-size: 13px; max-width: 320px; text-wrap: pretty; margin: 0; }
.empty .btn { margin-top: 8px; }
.card.empty { border-style: dashed; box-shadow: none; }

/* ---- board panel grid: a board's panels, on /boards and pinned in the studio ---- */
.bgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.bp-w2 { grid-column: span 2; }
.bp-w3 { grid-column: span 3; }
.bgrid h2 { font-size: 14px; }
@media (max-width: 720px) { .bgrid { grid-template-columns: minmax(0, 1fr); } .bp-w2, .bp-w3 { grid-column: auto; } }

/* Home's slot for pinned panels holds one panel row until the fragment lands, then the panels size it. */
.home-panels-slot[data-refresh] { min-height: 240px; margin-bottom: 16px; }

/* ---- settings shell ---- */
.settings { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin-top: 12px; }
.settings-nav {
  min-width: 0; display: none; flex-direction: column; gap: 14px;
}
.settings-nav a, .settings-jump-list a {
  display: flex; align-items: center; min-height: 28px; padding: 0 8px;
  font-size: 13px; color: var(--muted-fg); border-radius: var(--radius-sm);
}
.settings-nav a:hover, .settings-jump-list a:hover { background: var(--muted); color: var(--fg); }
.settings-nav a[aria-current="page"], .settings-jump-list a[aria-current="page"] { color: var(--fg); font-weight: 550; background: var(--muted); }
.settings-nav a[hidden], .settings-group[hidden] { display: none; }
.settings-group { display: flex; flex-direction: column; gap: 1px; }
.settings-group-name { margin: 0 0 2px; padding: 0 8px; font-size: 12.5px; font-weight: 500; color: var(--muted-fg); }
.settings-filter { width: 100%; font-size: 16px; }
.settings-jump { border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
.settings-jump > summary {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  min-height: 44px; padding: 0 12px; font-weight: 550; cursor: pointer; list-style: none;
}
.settings-jump > summary::-webkit-details-marker { display: none; }
.settings-jump[open] > summary .ico { transform: rotate(180deg); }
.settings-jump-list { display: grid; gap: 12px; padding: 4px 6px 12px; border-top: 1px solid var(--border); }
.settings-jump-list .settings-group-name { margin-top: 8px; }
.settings-jump-list a { min-height: 40px; font-size: 14px; }
.settings-main { min-width: 0; max-width: 860px; }
.settings-main > .card, .settings-main > .stack > .card, .settings-main > form > .card {
  border: 0; border-radius: 0; background: transparent; box-shadow: none; overflow: visible;
}
.settings-main > .card + .card, .settings-main > .stack > .card + .card { margin-top: 20px; }
.settings-main .card > .card-head {
  padding: 0 0 8px; background: transparent; border-bottom: 1px solid var(--border);
}
.settings-main .card > .card-head > .ico { display: none; }
.settings-main .card > .card-head :is(h2, h3) { font-size: 14px; font-weight: 600; }
.settings-main .card > .card-body { padding: 8px 0 0; }
.settings-main .card > .card-foot { padding: 10px 0 0; background: transparent; }
.settings-main .card > .list > li { padding-left: 0; padding-right: 0; }
.settings-main .card > .list .row { padding: 8px 0; gap: 10px; font-size: 13px; }
.settings-main .card > .list .row-lead { display: none; }
.settings-main .card > .card-body > p.muted.small { margin: 0 0 6px; }
@media (min-width: 860px) {
  .settings { grid-template-columns: 184px minmax(0, 1fr); gap: 40px; margin-top: 16px; }
  .settings-jump { display: none; }
  .settings-nav {
    display: flex; position: sticky; top: calc(var(--topbar-h) + 16px); align-self: start;
    max-height: calc(100dvh - var(--topbar-h) - 32px); overflow-y: auto; scrollbar-width: none;
  }
  .settings-filter { font-size: 13px; min-height: 30px; }
}

/* ---- settings content: status rows, blocks, a segmented control ---- */
.settings-block { margin-top: 24px; }
.settings-block:first-child { margin-top: 0; }
.settings-block > h2, .settings-block > .bar > h2 { font-size: 14px; font-weight: 600; margin: 0; }
.settings-block > h2 { margin-bottom: 8px; }
.settings-block > .bar { gap: 12px; flex-wrap: wrap; }
.settings-block > p { margin-top: 8px; }
.status-rows { margin: 24px 0 0; border-top: 1px solid var(--border); }
.status-row {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px 16px; align-items: center;
  padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px;
}
.status-row > dt { font-weight: 550; }
.status-row > dd { margin: 0; min-width: 0; }
.status-act { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.status-act:empty { display: none; }
@media (min-width: 640px) {
  .status-row { grid-template-columns: 168px minmax(0, 1fr) auto; }
  .status-act { justify-content: flex-end; }
}
.segmented { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--muted); }
.segmented form { display: contents; }
.segmented button, .segmented-on {
  display: inline-flex; align-items: center; min-height: 28px; padding: 0 12px;
  font: inherit; font-size: 13px; color: var(--muted-fg); background: transparent; border: 0; border-radius: var(--radius-sm); cursor: pointer;
}
.segmented button:hover { color: var(--fg); }
.segmented-on { color: var(--fg); font-weight: 550; background: var(--card); box-shadow: var(--shadow-1); cursor: default; }

.setting-table td { vertical-align: middle; }
.setting-table td { padding-top: 6px; padding-bottom: 6px; }
.setting-table td:first-child { max-width: 0; }
.setting-table td:first-child > :is(strong, span) { white-space: nowrap; }
.setting-table td:not(:first-child) { width: 1%; white-space: nowrap; }
.status-row .row-fields .input[type="number"] { width: 72px; }
.status-row .row-fields { flex-wrap: wrap; }
.status-row select.input { width: auto; }
.setting-table .row-fields { flex-wrap: nowrap; }
.setting-table .row-fields .input { width: 96px; }
@media (max-width: 639px) {
  .setting-table thead { display: none; }
  .setting-table, .setting-table tbody, .setting-table tr, .setting-table td { display: block; }
  .setting-table tr { padding: 10px 0; border-bottom: 1px solid var(--border); }
  .setting-table td { padding: 2px 0; border: 0; }
  .setting-table td:first-child { max-width: none; }
  .setting-table td:not(:first-child) { width: auto; }
}

/* ---- sticky primary action (thumb reach on a phone) ---- */
.sticky-action {
  position: sticky; bottom: 0; z-index: 8;
  display: flex; gap: 8px; align-items: center;
  padding: 10px 0 max(10px, env(safe-area-inset-bottom));
  background: linear-gradient(to top, var(--bg) 62%, transparent);
}
.sticky-action .btn { flex: 1; }
@media (min-width: 720px) { .sticky-action { position: static; background: none; padding: 0; } .sticky-action .btn { flex: none; } }

/* ---- live updates ---- */
.live-news {
  position: fixed; left: 0; right: 0; bottom: 20px; z-index: 25;
  display: flex; justify-content: center; pointer-events: none;
}
.live-news .badge {
  pointer-events: auto; min-height: 36px; padding: 0 14px; font-size: 13px;
  background: var(--card); box-shadow: var(--shadow-2);
  animation: pop 200ms var(--ease) both;
}

}

/* iOS zooms the whole page when a focused field is set below 16px, and the
   zoom drags the scroll with it. On a touch screen every field is 16px, so
   the page stays exactly where the reader left it. */
@media (pointer: coarse) {
  input, textarea, select, .input, .input[data-size="sm"], .topbar-search input,
  .palette .palette-input { font-size: 16px; }
}

/* Forced colours drop box-shadow rings and author colours: the focus ring is
   an outline the system paints. */
@media (forced-colors: active) {
  .input:focus-visible, .palette .palette-input:focus-visible { outline: 2px solid Highlight; outline-offset: 1px; }
  .color-field:focus-within { outline: 2px solid Highlight; outline-offset: 1px; }
}

/* Asked for less motion, the page keeps every state and loses the movement.
   \`!important\` because a bare \`*\` has no specificity: every class rule above
   that sets an animation or transition would win. Durations collapse rather
   than \`animation: none\`, so \`animationend\` still fires (src/web/live.ts
   removes its flash class on it). A busy loader stops turning and dims. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
  .btn[aria-busy="true"] .ico-loader { opacity: .6; }
}
`;
