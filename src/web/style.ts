/**
 * The design system: theme-driven CSS custom properties (see themes.ts) and
 * one readable, composable stylesheet. No preprocessor, no utility framework —
 * the stylesheet is the artifact, served as-is, and it is meant to be read.
 * Mobile is the base layer; desktop is the media query. Every color comes
 * from a token, so all six themes get every refinement for free.
 */

import { swatchCss, themeCss } from "./themes.ts";

const base = /* css */ `
/* ---- constants (theme-independent) ---- */
:root {
  --radius-sm: 6px;
  --radius: 8px;
  --radius-lg: 12px;
  --topbar-h: 57px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;
}

/* ---- base ---- */
* { box-sizing: border-box; margin: 0; }
/* The hidden attribute must always win — component display rules (.btn's
   inline-flex, .live-pill's) would otherwise override the UA sheet. */
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body {
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.6;
  background: var(--bg);
  color: var(--fg);
  min-height: 100dvh;
  display: flex; flex-direction: column;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: inherit; text-decoration: none; transition: color 120ms ease; }
a:hover { color: var(--accent); }
code, pre, .mono { font-family: var(--mono); font-size: 13px; }
h1 { font-size: 1.35rem; font-weight: 650; letter-spacing: -0.02em; text-wrap: balance; }
h2 { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.01em; }
h3 { font-size: 1rem; font-weight: 600; }
::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }

/* Momentary class the theme switcher adds so a theme change sweeps across
   the page instead of snapping. */
:root.theme-anim, :root.theme-anim *, :root.theme-anim *::before, :root.theme-anim *::after {
  transition: background-color 220ms ease, color 220ms ease,
    border-color 220ms ease, box-shadow 220ms ease !important;
}

/* Keyboard users get straight to the content; everyone else never sees it. */
.skip {
  position: absolute; left: 16px; top: -48px; z-index: 40;
  padding: 8px 14px; border-radius: var(--radius);
  background: var(--primary); color: var(--primary-fg);
  font-weight: 500; transition: top 140ms ease;
}
.skip:focus-visible { top: 10px; color: var(--primary-fg); }

/* ---- shell ---- */
.shell { width: 100%; max-width: 1120px; margin: 0 auto; padding: 0 16px 64px; flex: 1; }
.shell { animation: page-in 240ms ease both; }
@keyframes page-in { from { opacity: 0; transform: translateY(4px); } }

.topbar {
  position: sticky; top: 0; z-index: 10;
  min-height: var(--topbar-h);
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(14px) saturate(1.4);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  border-bottom: 1px solid var(--border);
}
.wordmark {
  display: inline-flex; align-items: center; gap: 8px;
  font-weight: 700; letter-spacing: -0.03em; font-size: 1.05rem;
}
.wordmark .mark {
  width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0;
  background: linear-gradient(135deg, var(--accent), var(--merged));
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 50%, transparent);
  transition: transform 320ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.wordmark:hover { color: var(--fg); }
.wordmark:hover .mark { transform: rotate(135deg); }
.topbar .crumbs { display: flex; align-items: center; gap: 6px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar .crumbs .sep { color: var(--faint); }
.topbar .crumbs a:last-child { font-weight: 550; }
.topbar .spacer { flex: 1; }

.foot {
  width: 100%; max-width: 1120px; margin: 0 auto;
  padding: 20px 16px 36px;
  display: flex; align-items: center; gap: 8px;
  color: var(--faint); font-size: 12.5px;
}
.foot .mark { width: 7px; height: 7px; border-radius: 2px; opacity: 0.7;
  background: linear-gradient(135deg, var(--accent), var(--merged)); }

/* ---- primitives ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; padding: 0 16px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--card); color: var(--fg);
  font: inherit; font-weight: 500; cursor: pointer;
  box-shadow: var(--shadow-1);
  transition: background 140ms ease, border-color 140ms ease,
    color 140ms ease, box-shadow 140ms ease, transform 80ms ease;
}
.btn:hover { background: var(--muted); border-color: var(--border-strong); color: var(--fg); }
.btn:active { transform: translateY(1px); box-shadow: none; }
.btn[data-variant="primary"] {
  background: var(--primary); color: var(--primary-fg); border-color: var(--primary);
}
.btn[data-variant="primary"]:hover { opacity: 0.88; }
.btn[data-variant="danger"] { color: var(--danger); }
.btn[data-variant="danger"]:hover { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); background: color-mix(in srgb, var(--danger) 8%, var(--card)); }
.btn[data-size="sm"] { min-height: 36px; padding: 0 12px; font-size: 13px; }
.btn-icon { padding: 0; width: 36px; }

.input, textarea.input {
  width: 100%; min-height: 44px; padding: 8px 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--card); color: var(--fg); font: inherit;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.input:hover { border-color: var(--border-strong); }
.input:focus, .input:focus-visible {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
}
label { display: block; font-size: 13px; font-weight: 500; margin: 14px 0 6px; }
textarea.input { resize: vertical; min-height: 88px; line-height: 1.5; font-family: inherit; }

.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  overflow: clip;
}
.card + .card { margin-top: 12px; }

.badge {
  display: inline-flex; align-items: center; gap: 5px; padding: 1px 9px;
  border: 1px solid var(--border); border-radius: 999px;
  font-size: 12px; font-weight: 500; color: var(--muted-fg);
  font-variant-numeric: tabular-nums;
}
.badge[data-state="open"] {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 40%, var(--border));
  background: color-mix(in srgb, var(--success) 9%, transparent);
}
.badge[data-state="closed"] {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
  background: color-mix(in srgb, var(--danger) 9%, transparent);
}
.badge[data-pr="merged"] {
  color: var(--merged);
  border-color: color-mix(in srgb, var(--merged) 40%, var(--border));
  background: color-mix(in srgb, var(--merged) 9%, transparent);
}

.muted { color: var(--muted-fg); }
.small { font-size: 13px; }

/* ---- menus (details-powered; work with zero JavaScript) ---- */
.menu { position: relative; }
.menu > summary { list-style: none; }
.menu > summary::-webkit-details-marker { display: none; }
.menu > summary::after {
  content: "▾"; font-size: 10px; color: var(--faint);
  transition: transform 160ms ease;
}
.menu[open] > summary::after { transform: rotate(180deg); }
.menu > summary.btn-icon::after { content: none; }
.menu-panel {
  position: absolute; right: 0; top: calc(100% + 8px); z-index: 30;
  min-width: 220px; padding: 6px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-2);
  transform-origin: top right;
  animation: menu-in 150ms cubic-bezier(0.2, 0.9, 0.3, 1.1) both;
}
@keyframes menu-in { from { opacity: 0; transform: translateY(-4px) scale(0.97); } }
.menu-title {
  display: block; padding: 6px 10px 4px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--faint);
}
.menu-item {
  display: flex; width: 100%; align-items: center; gap: 10px;
  padding: 8px 10px; border: 0; border-radius: var(--radius-sm);
  background: none; color: var(--fg); font: inherit; font-size: 14px;
  text-align: left; cursor: pointer;
  transition: background 100ms ease;
}
.menu-item:hover { background: var(--muted); color: var(--fg); }
.menu-sep { border: 0; border-top: 1px solid var(--border); margin: 6px 4px; }

/* ---- theme switcher ---- */
.theme-option {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 10px; margin: 0; border-radius: var(--radius-sm);
  font-size: 14px; font-weight: 400; cursor: pointer;
  transition: background 100ms ease;
}
.theme-option:hover { background: var(--muted); }
.theme-option input { position: absolute; opacity: 0; pointer-events: none; }
.theme-option .tick { margin-left: auto; color: var(--accent); opacity: 0; transform: scale(0.6); transition: opacity 140ms ease, transform 140ms ease; }
.theme-option:has(input:checked) { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.theme-option:has(input:checked) .tick { opacity: 1; transform: scale(1); }
.theme-option:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
.swatch {
  display: inline-block; flex-shrink: 0; position: relative;
  width: 22px; height: 22px; border-radius: 50%;
  border: 1px solid var(--border-strong);
}
.swatch::after { content: ""; position: absolute; inset: 6px; border-radius: 50%; }
.theme-apply { margin: 6px 10px 8px; }

/* ---- issues & conversations ---- */
.tabs {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 3px; background: var(--muted); border-radius: 10px;
}
.tabs .btn {
  min-height: 30px; padding: 0 12px; font-size: 13px;
  border-color: transparent; background: none; box-shadow: none;
  color: var(--muted-fg);
}
.tabs .btn:hover { color: var(--fg); background: color-mix(in srgb, var(--card) 55%, transparent); }
.tabs .btn[aria-current="page"] {
  background: var(--card); color: var(--fg);
  border-color: var(--border); box-shadow: var(--shadow-1);
}
.label-chip {
  display: inline-block; vertical-align: middle;
  padding: 0 8px; margin: 0 2px;
  border-radius: 999px; font-size: 12px; font-weight: 500; line-height: 18px;
  color: var(--label, var(--muted-fg));
  border: 1px solid color-mix(in srgb, var(--label, var(--border)) 50%, transparent);
  background: color-mix(in srgb, var(--label, var(--muted)) 12%, transparent);
}
.narrow-wide { max-width: 760px; }
.issue-head { margin: 20px 0 14px; }
.issue-head h1 { line-height: 1.25; font-size: clamp(1.25rem, 1.05rem + 1vw, 1.6rem); }
.issue-head h1 .muted { font-weight: 400; }
.issue-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
/* The conversation rail: a thread line that shows in the gaps between cards. */
#conversation { position: relative; }
#conversation::before {
  content: ""; position: absolute; left: 22px; top: 12px; bottom: 0;
  width: 2px; background: var(--border);
}
.comment { position: relative; margin-top: 12px; }
.comment-head {
  display: flex; align-items: baseline; gap: 8px;
  padding: 10px 16px; border-bottom: 1px solid var(--border);
  background: var(--muted);
}
.comment-body { padding: 4px 16px; }
.comment-body.md p:first-child { margin-top: 12px; }
.comment-form { margin-top: 20px; padding: 12px; overflow: visible; }
.comment-form textarea { margin-bottom: 10px; }

/* ---- spacing & layout utilities (so pages need no inline styles) ---- */
.mt { margin-top: 12px; }
.mb { margin-bottom: 12px; }
.center { text-align: center; }
.hero { position: relative; margin-top: 16dvh; }
.hero::before {
  content: ""; position: absolute; inset: -120px -60px; z-index: -1;
  background: radial-gradient(ellipse 60% 55% at 50% 30%,
    color-mix(in srgb, var(--accent) 13%, transparent), transparent 70%);
}
.hero h1 {
  font-size: clamp(2.4rem, 8vw, 3.2rem); letter-spacing: -0.045em;
  background: linear-gradient(135deg, var(--fg) 35%, color-mix(in srgb, var(--accent) 75%, var(--fg)));
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
}
.hero p { margin: 10px 0 28px; font-size: 1.05rem; }
.btn[aria-current="page"] { border-color: var(--accent); }

/* ---- lists ---- */
.list { list-style: none; padding: 0; }
.list > li { border-bottom: 1px solid var(--border); }
.list > li:last-child { border-bottom: none; }
.list .row {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; min-height: 44px;
  transition: background 100ms ease;
}
.list a.row:hover { background: var(--muted); color: inherit; }
.list a.row:hover .grow strong { color: var(--accent); transition: color 100ms ease; }
.list .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- repo pages ---- */
.repo-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 20px 0 10px;
}
.repo-head .spacer { flex: 1; }
.repo-tabs {
  display: flex; gap: 2px; margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto; scrollbar-width: none;
}
.repo-tabs::-webkit-scrollbar { display: none; }
.repo-tabs a {
  position: relative; padding: 8px 12px; white-space: nowrap;
  font-size: 14px; color: var(--muted-fg);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  transition: color 120ms ease, background 120ms ease;
}
.repo-tabs a:hover { color: var(--fg); background: var(--muted); }
.repo-tabs a[aria-current="page"] { color: var(--fg); font-weight: 550; }
.repo-tabs a[aria-current="page"]::after {
  content: ""; position: absolute; left: 8px; right: 8px; bottom: -1px;
  height: 2px; border-radius: 2px 2px 0 0; background: var(--accent);
}

/* ---- file tree ---- */
.tree .icon { width: 18px; text-align: center; color: var(--faint); flex-shrink: 0; }
.tree .row { padding: 9px 14px; min-height: 40px; }

/* ---- code view ---- */
.code { overflow-x: auto; border-radius: var(--radius); scrollbar-width: thin; }
.code table { border-collapse: collapse; width: 100%; }
.code td { padding: 0 12px; vertical-align: top; }
.code tr { scroll-margin-top: calc(var(--topbar-h) + 10px); }
.code .ln {
  width: 1%; min-width: 44px; text-align: right; user-select: none;
  color: var(--faint); font-family: var(--mono); font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.code .ln a { color: inherit; display: block; }
.code .ln a:hover { color: var(--accent); }
.code pre { white-space: pre; line-height: 1.55; min-height: 1.55em; font-variant-ligatures: none; }
.code tr:hover { background: color-mix(in srgb, var(--muted) 55%, transparent); }
.code tr:target { background: color-mix(in srgb, var(--accent) 13%, transparent); }
.code tr:target .ln { color: var(--accent); }

/* ---- syntax tokens (colors come from the active theme) ---- */
.tok-keyword { color: var(--tok-keyword); }
.tok-string { color: var(--tok-string); }
.tok-comment { color: var(--tok-comment); font-style: italic; }
.tok-number { color: var(--tok-number); }
.tok-function { color: var(--tok-function); }
.tok-type { color: var(--tok-type); }
.tok-constant { color: var(--tok-constant); }
.tok-meta { color: var(--tok-meta); }
.tok-operator, .tok-punctuation, .tok-plain { color: inherit; }

/* ---- markdown ---- */
.md { padding: 20px; overflow-wrap: break-word; }
.md h1, .md h2, .md h3 { margin: 22px 0 8px; }
.md h1:first-child, .md h2:first-child { margin-top: 0; }
.md h1, .md h2 { padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.md p, .md ul, .md ol, .md blockquote { margin: 10px 0; }
.md ul, .md ol { padding-left: 24px; }
.md li::marker { color: var(--faint); }
.md pre {
  background: var(--muted); border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px; overflow-x: auto; margin: 12px 0;
  scrollbar-width: thin;
}
.md code { background: var(--muted); border: 1px solid var(--border); padding: 1px 5px; border-radius: 5px; }
.md pre code { background: none; border: none; padding: 0; }
.md blockquote {
  border-left: 3px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  padding-left: 12px; color: var(--muted-fg);
}
.md a { color: var(--accent); text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; transition: text-decoration-color 140ms ease; }
.md a:hover { text-decoration-color: currentColor; }

/* ---- forms & auth ---- */
.narrow { max-width: 400px; margin: 8dvh auto 0; }
.form-actions { margin-top: 20px; display: flex; gap: 10px; align-items: center; }
.form-actions .spacer { flex: 1; }
.error-note { color: var(--danger); font-size: 14px; margin-top: 12px; }

/* ---- page furniture ---- */
.page-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 20px 0 14px;
}
.page-head .spacer { flex: 1; }
.clone {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 12.5px;
  padding: 8px 12px; overflow-x: auto; white-space: nowrap;
  scrollbar-width: thin;
  user-select: all; /* one tap selects the whole clone command */
}
.empty { padding: 52px 20px; text-align: center; color: var(--muted-fg); }
.card.empty { border-style: dashed; box-shadow: none; }
.hide-sm { display: none; }

/* ---- diff viewer ---- */
.diff-summary { padding: 12px 16px; }
.diff-summary .add { color: var(--add-fg); font-weight: 600; }
.diff-summary .del { color: var(--del-fg); font-weight: 600; }

.diff-file {
  margin-top: 14px;
  /* Pure-CSS windowing: off-screen files cost nothing until scrolled to. */
  content-visibility: auto;
  contain-intrinsic-size: auto 480px;
}
.diff-head {
  position: sticky; top: calc(var(--topbar-h) - 1px); z-index: 5;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; cursor: pointer; list-style: none;
  background: var(--muted); border-bottom: 1px solid var(--border);
}
.diff-head::-webkit-details-marker { display: none; }
.diff-head::before {
  content: "▸"; color: var(--faint); font-size: 11px; width: 12px; flex-shrink: 0;
  transition: transform 160ms ease;
}
.diff-file[open] .diff-head::before { transform: rotate(90deg); }
.diff-file:not([open]) .diff-head { border-bottom: none; }
.diff-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.diff-stat { font-family: var(--mono); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.diff-stat .add { color: var(--add-fg); }
.diff-stat .del { color: var(--del-fg); }
.diff-note { padding: 24px 16px; text-align: center; color: var(--muted-fg); }

.diff-body { overflow-x: auto; scrollbar-width: thin; }
.diff-table { border-collapse: collapse; width: 100%; font-family: var(--mono); font-size: 12.5px; }
.diff-table td { padding: 0; vertical-align: top; }
.dn {
  width: 1%; min-width: 40px; padding: 0 8px; text-align: right;
  color: var(--faint); user-select: none;
  white-space: nowrap; border-right: 1px solid var(--border);
  font-variant-numeric: tabular-nums;
}
.dc {
  width: 100%; padding: 0 8px 0 12px; white-space: pre;
  border-left: 3px solid transparent;
  font-variant-ligatures: none;
}
.dcx { display: inline-block; min-height: 1.5em; } /* blank lines keep height */
/* The +/-/space marker lives in ::before so selecting/copying skips it. */
.dc::before { content: attr(data-mark) " "; color: var(--faint); }
.dl[data-k="add"] .dc { background: var(--add-bg); border-left-color: var(--add-edge); }
.dl[data-k="add"] .dn { background: color-mix(in srgb, var(--add-bg) 60%, transparent); }
.dl[data-k="add"] .dc::before { color: var(--add-fg); }
.dl[data-k="del"] .dc { background: var(--del-bg); border-left-color: var(--del-edge); }
.dl[data-k="del"] .dn { background: color-mix(in srgb, var(--del-bg) 60%, transparent); }
.dl[data-k="del"] .dc::before { color: var(--del-fg); }
/* Intra-line change: a second layer — saturation plus underline, never hue alone. */
.dl[data-k="add"] .wd { background: var(--wd-add); text-decoration: underline; text-underline-offset: 2px; border-radius: 2px; }
.dl[data-k="del"] .wd { background: var(--wd-del); text-decoration: underline; text-underline-offset: 2px; border-radius: 2px; }
.dh .dc { background: var(--muted); border-left-color: transparent; padding-top: 2px; padding-bottom: 2px; color: var(--muted-fg); }
.dh .dc::before { content: ""; }
.nonl { color: var(--del-fg); opacity: 0.7; padding-left: 8px; }
/* line-number as a comment affordance */
.dn-comment { color: var(--faint); display: block; position: relative; transition: background 100ms ease, color 100ms ease; }
.dn-comment:hover { color: var(--accent-fg); background: var(--accent); border-radius: 3px; }
/* review comments ride under their line, full width */
.dl-review .dc-review { padding: 8px 12px; background: var(--muted); border-left: 3px solid var(--accent); white-space: normal; font-family: var(--font); }
.rc { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; margin-bottom: 8px; }
.rc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.rc-body { font-size: 13.5px; }
.rc-body p:first-child { margin-top: 0; }
.rc-outdated { color: var(--del-fg); border-color: color-mix(in srgb, var(--del-fg) 40%, var(--border)); }
.rc-form { display: block; }
.rc-form textarea { width: 100%; }

/* ---- pull requests ---- */
.branch-pick { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.branch-pick label { display: inline-flex; align-items: center; gap: 8px; margin: 8px 0; }
.branch-pick select { min-width: 140px; }
.merge-box {
  margin-top: 14px; padding: 14px 16px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  border-left: 3px solid var(--border);
}
.merge-box[data-status="ready"] { border-left-color: var(--success); border-color: color-mix(in srgb, var(--success) 45%, var(--border)); }
.merge-box[data-status="blocked"] { border-left-color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.merge-box[data-status="merged"] { border-left-color: var(--merged); border-color: color-mix(in srgb, var(--merged) 45%, var(--border)); }
.merge-ready { color: var(--success); font-weight: 600; }
.merge-form { display: flex; gap: 10px; align-items: center; margin-left: auto; flex-wrap: wrap; }
.merge-form select { min-width: 160px; }

/* ---- commit detail ---- */
.commit-head { padding: 16px; margin-bottom: 4px; }
.commit-head h2 { margin-bottom: 8px; }
.commit-body {
  white-space: pre-wrap; font-family: var(--mono); font-size: 13px;
  color: var(--muted-fg); margin: 8px 0 12px;
}

/* ---- settings ---- */
.settings-card { padding: 16px; margin-top: 14px; overflow: visible; }
.settings-card h3 { margin-bottom: 10px; }
.check { display: flex; align-items: flex-start; gap: 8px; font-weight: 400; }
.check input { margin-top: 3px; accent-color: var(--accent); }
.label-list { list-style: none; padding: 0; margin: 0 0 12px; }
.label-list li { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.inline { display: inline; }
.label-new { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.label-new .input { flex: 1; min-width: 140px; }
.label-new .color { flex: 0 0 110px; font-family: var(--mono); }
.hook-list { list-style: none; padding: 0; margin: 0 0 12px; }
.hook-list li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.hook-list li:last-child { border-bottom: none; }
.hook-list .mono { word-break: break-all; }
.hook-new { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.hook-new .input { flex: 1; min-width: 160px; }
.fork-bar { display: flex; align-items: center; gap: 12px; margin: -4px 0 12px; flex-wrap: wrap; }
.fork-bar .spacer { flex: 1; }
.token-fresh { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); }
.token-fresh .clone { margin-top: 8px; }

/* ---- live updates ---- */
.live-pill {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 20;
  padding: 8px 16px; min-height: 40px; display: inline-flex; align-items: center;
  background: var(--accent); color: var(--accent-fg); border-radius: 999px;
  font-size: 13px; font-weight: 500;
  box-shadow: var(--shadow-2);
  animation: pill-in 260ms cubic-bezier(0.2, 0.9, 0.3, 1.2) both;
}
.live-pill:hover { color: var(--accent-fg); opacity: 0.92; }
@keyframes pill-in { from { opacity: 0; transform: translateX(-50%) translateY(16px); } }
#conversation .comment.live-new { animation: live-in 400ms ease; }
@keyframes live-in { from { background: color-mix(in srgb, var(--accent) 12%, var(--card)); } to {} }

/* ---- desktop ---- */
@media (min-width: 720px) {
  body { font-size: 14.5px; }
  .shell { padding: 0 24px 64px; }
  .topbar { padding: 10px 24px; }
  .foot { padding: 20px 24px 36px; }
  .hide-sm { display: inline-flex; }
}

/* ---- motion & print ---- */
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
@media print {
  .topbar, .foot, .live-pill { display: none; }
  .shell { animation: none; }
}
`;

export const css = [themeCss, base, swatchCss].join("\n");
