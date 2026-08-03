/**
 * The design system: one flat namespace of CSS custom properties, one dark
 * override, and a small set of composable classes. No preprocessor, no
 * utility framework — the stylesheet is the artifact, served as-is, and it
 * is meant to be read. Mobile is the base layer; desktop is the media query.
 */

export const css = /* css */ `
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

.muted { color: var(--muted-fg); }
.small { font-size: 13px; }

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
.code pre { white-space: pre; line-height: 1.55; }
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
`;
