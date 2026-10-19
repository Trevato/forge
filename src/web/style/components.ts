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
.input:focus, .input:focus-visible {
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

/* One control for every boolean. A native checkbox tinted with accent-color
   is themed for free, keyboard-correct for free, and honest about what it is —
   a hand-built switch would be none of those. */
.check {
  display: inline-flex; align-items: flex-start; gap: 8px;
  font-weight: 400; font-size: 14px; cursor: pointer; margin: 0;
}
.check input { accent-color: var(--accent); margin-top: 2px; flex: none; }

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
/* A passkey ceremony's note slot looks like an error only once it says one. */
.error-note, .passkey-note:not(:empty) {
  display: block; color: var(--danger); font-size: 13px; font-weight: 500;
  padding: 8px 12px; margin: 0 0 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 32%, transparent);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border-radius: var(--radius-sm);
}
/* Where a passkey can run — a script, and a browser with WebAuthn, which
   passkey-client.ts marks as :root.passkey — .passkey-on shows and
   .passkey-off hides; everywhere else the other way round. Only ever hides,
   so each element keeps its own display. */
:root:not(.passkey) .passkey-on, :root.passkey .passkey-off { display: none; }
/* /signin's passkey lead: a full-width button whose note takes no room until
   it says something. */
.passkey-lead { margin-bottom: 16px; }
.passkey-lead > .btn { width: 100%; }
.passkey-lead > .passkey-note:not(:empty) { margin: 8px 0 0; }

/* ---- badge / label chip / pill / dot ---- */
.badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px;
  border: 1px solid var(--border); border-radius: 999px;
  font-size: 11.5px; font-weight: 500; line-height: 18px; color: var(--muted-fg);
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
@keyframes spin { to { transform: rotate(360deg); } }

/* One stored hex, derived three ways, so a chip reads correctly in all six
   themes. --label is set by a per-page nonce'd rule; the hex is validated
   before it is ever embedded. */
.label {
  --label: var(--muted-fg);
  display: inline-flex; align-items: center; padding: 0 8px;
  border-radius: 999px; font-size: 11.5px; font-weight: 500; line-height: 18px;
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
  font-size: 11.5px; font-weight: 550; line-height: 18px;
  font-variant-numeric: tabular-nums;
}
.pill[data-tone="accent"] { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.pill[data-tone="danger"] { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); }

.dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: var(--faint); flex: none; }
.dot[data-tone="success"] { background: var(--success); }
.dot[data-tone="danger"] { background: var(--danger); }
.dot[data-tone="attn"] { background: var(--attn); }
.dot[data-tone="merged"] { background: var(--merged); }

kbd {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 5px;
  border: 1px solid var(--border); border-bottom-width: 2px;
  border-radius: var(--radius-sm); background: var(--muted);
  font-family: var(--mono); font-size: 11.5px; font-weight: 500; color: var(--muted-fg);
}

.sha {
  font-family: var(--mono); font-size: 12.5px; padding: 1px 5px;
  border-radius: 4px; background: var(--muted); color: var(--muted-fg);
  font-variant-numeric: tabular-nums;
}
a.sha:hover { color: var(--accent); }

/* ---- avatar ----
   The hue is the person's (--hue), so it is mixed here, not a palette token;
   the 20px and 16px circles' initials sit below the type scale on purpose. */
.avatar {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 20px; height: 20px; border-radius: 999px;
  background: color-mix(in srgb, hsl(var(--hue, 220) 62% 52%) 22%, var(--card));
  color: color-mix(in srgb, hsl(var(--hue, 220) 62% 42%) 88%, var(--fg));
  border: 1px solid color-mix(in srgb, hsl(var(--hue, 220) 62% 52%) 30%, transparent);
  font-size: 9.5px; font-weight: 650; letter-spacing: 0; text-transform: uppercase;
  user-select: none;
}
.avatar[data-size="md"] { width: 28px; height: 28px; font-size: 12.5px; }
.avatar[data-size="lg"] { width: 56px; height: 56px; font-size: 20px; border-radius: var(--radius-lg); }

.byline { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.byline a:hover { color: var(--accent); }
.name-mark {
  display: inline-block; padding: 0 5px; border-radius: 4px;
  font-size: 11.5px; font-weight: 600; line-height: 15px; letter-spacing: 0.04em;
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
:is(.stack, .dash, .split, .timeline) > .card + .card { margin-top: 0; }
.card-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--muted);
}
.card-head h2, .card-head h3 { margin: 0; }
.card-body { padding: 14px; }
.card-foot {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 14px; border-top: 1px solid var(--border); background: var(--muted);
}
.card[data-tone="success"] { border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }
.card[data-tone="danger"] { border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.card[data-tone="merged"] { border-color: color-mix(in srgb, var(--merged) 40%, var(--border)); }
.card[data-tone="attn"] { border-color: color-mix(in srgb, var(--attn) 40%, var(--border)); }

/* ---- list rows ---- */
.list > li + li { border-top: 1px solid var(--border); }
.row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 14px; min-height: 40px;
  transition: background-color 100ms var(--ease);
}
.row:focus-visible { outline-offset: -2px; }
a.row:hover, .row[data-nav]:hover { background: var(--muted); color: inherit; }
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
.row-meta .avatar { width: 16px; height: 16px; font-size: 8.5px; vertical-align: -0.28em; }
.row-meta .byline-name { margin-left: 4px; }
.row-lead { color: var(--faint); display: inline-flex; flex: none; }
.row-trail { display: flex; align-items: center; gap: 8px; flex: none; }
/* The leading glyph is the row's state; a badge repeating it is noise. */
.row[data-state="open"] .row-lead { color: var(--success); }
.row[data-state="closed"] .row-lead { color: var(--danger); }
.row[data-state="merged"] .row-lead { color: var(--merged); }
.row[data-state="draft"] .row-lead { color: var(--muted-fg); }
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
.color-field .hex { font-family: var(--mono); font-size: 12.5px; color: var(--muted-fg); }
@media (pointer: coarse) { .color-field { min-height: 44px; } }
@media (max-width: 719px) {
  .edit-row { align-items: stretch; }
  .edit-row > .input { flex-basis: 100%; }
  .edit-row .color-field, .edit-row .btn { flex: 1 1 auto; justify-content: center; }
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
.table-scroll { overflow-x: auto; scrollbar-width: thin; }
/* The row's name stays in view while a narrow screen scrolls the figures. */
.table[data-sticky-lead] th:first-child,
.table[data-sticky-lead] td:first-child {
  position: sticky; left: 0; z-index: 1; background: var(--card);
}

/* ---- tabs (navigation links, never role=tab) ---- */
.tabs {
  display: flex; gap: 2px; align-items: stretch;
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
  height: 2px; border-radius: 2px 2px 0 0; background: var(--fg);
}
@media (min-width: 720px) { .tabs { mask-image: none; } }

/* ---- segmented control (radios in a GET form, or links) ---- */
.seg {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
  padding: 2px; background: var(--muted); border-radius: var(--radius);
}
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
  max-height: min(70vh, 480px); overflow-y: auto; scrollbar-width: thin;
}
.menu[data-align="start"] > .menu-panel { right: auto; left: 0; }
@keyframes pop { from { opacity: 0; transform: translateY(-4px); } }
.menu-title {
  display: block; padding: 6px 10px 4px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .08em;
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
  font-size: 13px; color: var(--fg);
}
.topbar-search kbd { flex: none; }

/* ---- theme switcher ---- */
.theme-option {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 10px; margin: 0; border-radius: var(--radius-sm);
  font-size: 14px; font-weight: 400; cursor: pointer;
  transition: background-color 100ms var(--ease);
}
.theme-option:hover { background: var(--muted); }
.theme-option input { position: absolute; opacity: 0; pointer-events: none; }
.theme-option .tick {
  margin-left: auto; color: var(--accent); opacity: 0;
  transition: opacity 140ms var(--ease);
}
.theme-option:has(input:checked) { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.theme-option:has(input:checked) .tick { opacity: 1; }
.theme-option:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
.swatch {
  display: inline-block; flex: none; position: relative;
  width: 20px; height: 20px; border-radius: 999px;
  border: 1px solid var(--border-strong);
}
.swatch::after { content: ""; position: absolute; inset: 6px; border-radius: 999px; }
.theme-apply { margin: 6px 10px 8px; }

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
.palette .palette-input:focus { box-shadow: none; border-color: var(--border); }
/* A height, not a ceiling: the dialog must not jump as rows come and go
   under a query. */
.palette-list {
  height: min(46dvh, 420px); overflow-y: auto; overscroll-behavior: contain;
  padding: 6px; scrollbar-width: thin;
}
.palette-group + .palette-group { margin-top: 4px; }
.palette-heading {
  padding: 8px 10px 4px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .08em;
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
.toast code, .toast .clone { display: block; margin-top: 6px; }

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

/* ---- breadcrumbs ---- */
.crumbs {
  display: flex; align-items: center; gap: 4px; min-width: 0;
  font-size: 14px; overflow: hidden;
}
.crumbs a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* On a phone the crumbs would be squeezed to "y… / c."; the page header
   right below says where you are, in full. */
@media (max-width: 719px) { .topbar .crumbs { display: none; } }
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
.tl-item { position: relative; padding-left: 36px; }
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
.tl-item[data-kind="comment"] .card { margin: 0; }

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
}
.empty p { font-size: 13px; max-width: 320px; text-wrap: pretty; margin: 0; }
.empty .btn { margin-top: 8px; }
.card.empty { border-style: dashed; box-shadow: none; }

/* ---- settings shell ---- */
.settings { display: grid; gap: 20px; margin-top: 16px; }
.settings-nav {
  display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none;
  border-bottom: 1px solid var(--border);
}
.settings-nav::-webkit-scrollbar { display: none; }
.settings-nav a {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 0 12px; min-height: 36px; white-space: nowrap;
  font-size: 14px; color: var(--muted-fg); border-radius: var(--radius-sm);
}
.settings-nav a:hover { background: var(--muted); color: var(--fg); }
.settings-nav a[aria-current="page"] { color: var(--fg); font-weight: 550; background: var(--muted); }
.settings-main { min-width: 0; }
@media (min-width: 860px) {
  .settings { grid-template-columns: 190px minmax(0, 1fr); gap: 32px; }
  .settings-nav {
    flex-direction: column; border-bottom: 0; position: sticky;
    top: calc(var(--topbar-h) + 16px); align-self: start;
  }
}

/* ---- clone strip ---- */
.clone {
  display: flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 12.5px;
  padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--muted); min-width: 0;
}
.clone > .clone-text {
  flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap;
  scrollbar-width: none; user-select: all;
}
.clone > .clone-text::-webkit-scrollbar { display: none; }

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
.live-pill {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 25;
  padding: 0 14px; min-height: 36px; display: inline-flex; align-items: center; gap: 6px;
  background: var(--primary); color: var(--primary-fg); border-radius: 999px;
  font-size: 13px; font-weight: 500; box-shadow: var(--shadow-2);
  animation: pop 200ms var(--ease) both;
}
.live-pill:hover { color: var(--primary-fg); opacity: .92; }
.live-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

}

/* iOS zooms the whole page when a focused field is set below 16px, and the
   zoom drags the scroll with it. On a touch screen every field is 16px, so
   the page stays exactly where the reader left it. */
@media (pointer: coarse) {
  input, textarea, select, .input, .input[data-size="sm"], .topbar-search input,
  .palette .palette-input { font-size: 16px; }
}
`;
