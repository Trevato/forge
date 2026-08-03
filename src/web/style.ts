/**
 * The design system: one flat namespace of CSS custom properties, one dark
 * override, and a small set of composable classes. No preprocessor, no
 * utility framework — the stylesheet is the artifact, served as-is, and it
 * is meant to be read. Mobile is the base layer; desktop is the media query.
 */

import { highlightCss } from "./highlight-theme.ts";

const base = /* css */ `
/* ---- tokens ---- */
:root {
  --bg: #fafafa;
  --fg: #18181b;
  --card: #ffffff;
  --muted: #f4f4f5;
  --muted-fg: #71717a;
  --border: #e4e4e7;
  --primary: #18181b;
  --primary-fg: #fafafa;
  --accent: #2563eb;
  --danger: #dc2626;
  --success: #16a34a;
  --add-bg: #e6ffec;
  --add-fg: #1a7f37;
  --add-edge: #2da44e;
  --del-bg: #ffebe9;
  --del-fg: #cf222e;
  --del-edge: #cf222e;
  --wd-add: #abf2bc;
  --wd-del: #ffc9c2;
  --radius: 8px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #09090b;
    --fg: #fafafa;
    --card: #101014;
    --muted: #18181b;
    --muted-fg: #a1a1aa;
    --border: #27272a;
    --primary: #fafafa;
    --primary-fg: #18181b;
    --accent: #3b82f6;
    --add-bg: #12261e;
    --add-fg: #3fb950;
    --add-edge: #2ea043;
    --del-bg: #25171c;
    --del-fg: #f85149;
    --del-edge: #f85149;
    --wd-add: #1b4721;
    --wd-del: #5a1e21;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #09090b;
  --fg: #fafafa;
  --card: #101014;
  --muted: #18181b;
  --muted-fg: #a1a1aa;
  --border: #27272a;
  --primary: #fafafa;
  --primary-fg: #18181b;
  --accent: #3b82f6;
  --add-bg: #12261e;
  --add-fg: #3fb950;
  --add-edge: #2ea043;
  --del-bg: #25171c;
  --del-fg: #f85149;
  --del-edge: #f85149;
  --wd-add: #1b4721;
  --wd-del: #5a1e21;
  color-scheme: dark;
}

/* ---- base ---- */
* { box-sizing: border-box; margin: 0; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.6;
  background: var(--bg);
  color: var(--fg);
  min-height: 100dvh;
}
a { color: inherit; text-decoration: none; }
a:hover { color: var(--accent); }
code, pre, .mono { font-family: var(--mono); font-size: 13px; }
h1 { font-size: 1.35rem; font-weight: 650; letter-spacing: -0.01em; }
h2 { font-size: 1.1rem; font-weight: 600; }
h3 { font-size: 1rem; font-weight: 600; }

/* ---- shell ---- */
.shell { max-width: 1080px; margin: 0 auto; padding: 0 16px 64px; }
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}
.topbar .wordmark { font-weight: 700; letter-spacing: -0.02em; font-size: 1.05rem; }
.topbar .crumbs { display: flex; align-items: center; gap: 6px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar .crumbs .sep { color: var(--muted-fg); }
.topbar .spacer { flex: 1; }

/* ---- primitives ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; padding: 0 16px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--card); color: var(--fg);
  font: inherit; font-weight: 500; cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.btn:hover { background: var(--muted); color: var(--fg); }
.btn[data-variant="primary"] {
  background: var(--primary); color: var(--primary-fg); border-color: var(--primary);
}
.btn[data-variant="primary"]:hover { opacity: 0.9; }
.btn[data-variant="danger"] { color: var(--danger); }
.btn[data-size="sm"] { min-height: 34px; padding: 0 12px; font-size: 13px; }

.input, textarea.input {
  width: 100%; min-height: 44px; padding: 8px 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--card); color: var(--fg); font: inherit;
}
.input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
label { display: block; font-size: 13px; font-weight: 500; margin: 14px 0 6px; }

.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.card + .card { margin-top: 12px; }

.badge {
  display: inline-block; padding: 1px 8px;
  border: 1px solid var(--border); border-radius: 999px;
  font-size: 12px; color: var(--muted-fg);
}
.badge[data-state="open"] { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }
.badge[data-state="closed"] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }

textarea.input { resize: vertical; min-height: 88px; line-height: 1.5; font-family: inherit; }

.muted { color: var(--muted-fg); }
.small { font-size: 13px; }

/* ---- issues & conversations ---- */
.tabs { display: flex; gap: 6px; }
.label-chip {
  display: inline-block; vertical-align: middle;
  padding: 0 8px; margin: 0 2px;
  border-radius: 999px; font-size: 12px; font-weight: 500; line-height: 18px;
  color: var(--label, var(--muted-fg));
  border: 1px solid color-mix(in srgb, var(--label, var(--border)) 50%, transparent);
  background: color-mix(in srgb, var(--label, var(--muted)) 12%, transparent);
}
.narrow-wide { max-width: 720px; }
.issue-head { margin: 18px 0 12px; }
.issue-head h1 { line-height: 1.25; }
.issue-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.comment { margin-top: 12px; overflow: hidden; }
.comment-head {
  display: flex; align-items: baseline; gap: 8px;
  padding: 10px 16px; border-bottom: 1px solid var(--border);
  background: var(--muted);
}
.comment-body { padding: 4px 16px; }
.comment-body.md p:first-child { margin-top: 12px; }
.comment-form { margin-top: 16px; padding: 12px; }
.comment-form textarea { margin-bottom: 10px; }

/* ---- spacing & layout utilities (so pages need no inline styles) ---- */
.mt { margin-top: 12px; }
.mb { margin-bottom: 12px; }
.center { text-align: center; }
.hero { margin-top: 22dvh; }
.hero p { margin: 8px 0 24px; }
.btn[aria-current="page"] { border-color: var(--accent); }

/* ---- lists ---- */
.list { list-style: none; padding: 0; }
.list > li { border-bottom: 1px solid var(--border); }
.list > li:last-child { border-bottom: none; }
.list .row {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; min-height: 44px;
}
.list a.row:hover { background: var(--muted); color: inherit; }
.list .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- file tree ---- */
.tree .icon { width: 18px; text-align: center; color: var(--muted-fg); flex-shrink: 0; }
.tree .row { padding: 9px 14px; min-height: 40px; }

/* ---- code view ---- */
.code {
  overflow-x: auto;
  border-radius: var(--radius);
}
.code table { border-collapse: collapse; width: 100%; }
.code td { padding: 0 12px; vertical-align: top; }
.code .ln {
  width: 1%; min-width: 44px; text-align: right; user-select: none;
  color: var(--muted-fg); font-family: var(--mono); font-size: 13px;
}
.code .ln a { color: inherit; display: block; }
.code pre { white-space: pre; line-height: 1.55; min-height: 1.55em; }
.code tr:target { background: color-mix(in srgb, var(--accent) 12%, transparent); }

/* ---- markdown ---- */
.md { padding: 20px; overflow-wrap: break-word; }
.md h1, .md h2, .md h3 { margin: 20px 0 8px; }
.md h1:first-child { margin-top: 0; }
.md p, .md ul, .md ol, .md blockquote { margin: 10px 0; }
.md ul, .md ol { padding-left: 24px; }
.md pre {
  background: var(--muted); border-radius: var(--radius);
  padding: 12px; overflow-x: auto; margin: 12px 0;
}
.md code { background: var(--muted); padding: 1px 5px; border-radius: 4px; }
.md pre code { background: none; padding: 0; }
.md blockquote { border-left: 3px solid var(--border); padding-left: 12px; color: var(--muted-fg); }
.md a { color: var(--accent); }

/* ---- forms & auth ---- */
.narrow { max-width: 400px; margin: 8dvh auto 0; }
.form-actions { margin-top: 20px; display: flex; gap: 10px; align-items: center; }
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
}
.empty { padding: 48px 16px; text-align: center; color: var(--muted-fg); }

/* ---- desktop ---- */
@media (min-width: 720px) {
  body { font-size: 14.5px; }
  .shell { padding: 0 24px 64px; }
  .topbar { padding: 10px 24px; }
}

/* ---- diff viewer ---- */
.diff-summary { padding: 12px 16px; }
.diff-summary .add { color: var(--add-fg); font-weight: 600; }
.diff-summary .del { color: var(--del-fg); font-weight: 600; }

.diff-file {
  margin-top: 14px; overflow: hidden;
  /* Pure-CSS windowing: off-screen files cost nothing until scrolled to. */
  content-visibility: auto;
  contain-intrinsic-size: auto 480px;
}
.diff-head {
  position: sticky; top: 49px; z-index: 5;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; cursor: pointer; list-style: none;
  background: var(--muted); border-bottom: 1px solid var(--border);
}
.diff-head::-webkit-details-marker { display: none; }
.diff-head::before {
  content: "▾"; color: var(--muted-fg); font-size: 11px; width: 12px; flex-shrink: 0;
}
.diff-file:not([open]) .diff-head::before { content: "▸"; }
.diff-file:not([open]) .diff-head { border-bottom: none; }
.diff-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.diff-stat { font-family: var(--mono); font-size: 12px; white-space: nowrap; }
.diff-stat .add { color: var(--add-fg); }
.diff-stat .del { color: var(--del-fg); }
.diff-note { padding: 24px 16px; text-align: center; color: var(--muted-fg); }

.diff-body { overflow-x: auto; }
.diff-table { border-collapse: collapse; width: 100%; font-family: var(--mono); font-size: 12.5px; }
.diff-table td { padding: 0; vertical-align: top; }
.dn {
  width: 1%; min-width: 40px; padding: 0 8px; text-align: right;
  color: var(--muted-fg); user-select: none;
  white-space: nowrap; border-right: 1px solid var(--border);
}
.dc {
  width: 100%; padding: 0 8px 0 12px; white-space: pre;
  border-left: 3px solid transparent;
}
.dcx { display: inline-block; min-height: 1.5em; } /* blank lines keep height */
/* The +/-/space marker lives in ::before so selecting/copying skips it. */
.dc::before { content: attr(data-mark) " "; color: var(--muted-fg); }
.dl[data-k="add"] .dc { background: var(--add-bg); border-left-color: var(--add-edge); }
.dl[data-k="add"] .dn { background: color-mix(in srgb, var(--add-bg) 60%, transparent); }
.dl[data-k="add"] .dc::before { color: var(--add-fg); }
.dl[data-k="del"] .dc { background: var(--del-bg); border-left-color: var(--del-edge); }
.dl[data-k="del"] .dn { background: color-mix(in srgb, var(--del-bg) 60%, transparent); }
.dl[data-k="del"] .dc::before { color: var(--del-fg); }
/* Intra-line change: a second layer — saturation plus underline, never hue alone. */
.dl[data-k="add"] .wd { background: var(--wd-add); text-decoration: underline; text-underline-offset: 2px; border-radius: 2px; }
.dl[data-k="del"] .wd { background: var(--wd-del); text-decoration: underline; text-underline-offset: 2px; border-radius: 2px; }
.dh .dc { background: var(--muted); border-left-color: transparent; padding-top: 2px; padding-bottom: 2px; }
.dh .dc::before { content: ""; }
.nonl { color: var(--del-fg); opacity: 0.7; padding-left: 8px; }
/* line-number as a comment affordance */
.dn-comment { color: var(--muted-fg); display: block; position: relative; }
.dn-comment:hover { color: var(--primary-fg); background: var(--accent); border-radius: 3px; }
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
.badge[data-pr="merged"] { color: #8250df; border-color: color-mix(in srgb, #8250df 40%, var(--border)); }
.branch-pick { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.branch-pick label { display: inline-flex; align-items: center; gap: 8px; margin: 8px 0; }
.branch-pick select { min-width: 140px; }
.merge-box {
  margin-top: 14px; padding: 14px 16px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.merge-box[data-status="ready"] { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); }
.merge-box[data-status="blocked"] { border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.merge-box[data-status="merged"] { border-color: color-mix(in srgb, #8250df 45%, var(--border)); }
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
.repo-nav { flex-wrap: wrap; }
.settings-card { padding: 16px; margin-top: 14px; }
.settings-card h3 { margin-bottom: 10px; }
.check { display: flex; align-items: flex-start; gap: 8px; font-weight: 400; }
.check input { margin-top: 3px; }
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

/* ---- live updates ---- */
.live-pill {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 20;
  padding: 8px 16px; min-height: 40px; display: inline-flex; align-items: center;
  background: var(--accent); color: #fff; border-radius: 999px; font-size: 13px; font-weight: 500;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2);
}
.live-pill:hover { color: #fff; opacity: 0.92; }
#conversation .comment.live-new { animation: live-in 400ms ease; }
@keyframes live-in { from { background: color-mix(in srgb, var(--accent) 12%, var(--card)); } to {} }
`;

export const css = base + highlightCss;
