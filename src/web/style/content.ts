/**
 * What pages put inside the components: rendered prose, a file's source, and
 * the diff — plus the page furniture that frames them (page head, repo
 * header, merge box, file tree). The diff is the product, so it gets the most
 * attention here: hairline gutters, an opaque sticky file header, a `+`/`−`
 * glyph that survives copy-paste, and an intra-line change signalled by two
 * channels (tint and underline) so color is never the only one.
 */

export const content = /* css */ `
@layer content {

/* ---- page furniture ---- */
.page-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 20px 0 14px;
}
.page-head h1 { min-width: 0; }
.page-head .sub { flex-basis: 100%; color: var(--muted-fg); font-size: 13px; margin-top: -4px; }

.repo-head { margin: 18px 0 0; view-transition-name: repo-head; }
.repo-title {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 18px; font-weight: 620; letter-spacing: -0.02em; line-height: 1.3;
}
.repo-title .owner { font-weight: 400; color: var(--muted-fg); }
.repo-title .slash { color: var(--faint); font-weight: 400; }
.repo-desc { margin-top: 4px; color: var(--muted-fg); font-size: 13.5px; text-wrap: pretty; }
.repo-lineage { margin-top: 3px; font-size: 12.5px; color: var(--faint); }
.repo-head .tabs { margin-top: 12px; }

/* Provenance and pinning: one line under the title, so a <form> never has to
   live inside the <h1>. */
.repo-origin {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 6px; min-height: 26px;
}
.origin-chip {
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--muted); color: var(--muted-fg);
  font-size: 12.5px; text-decoration: none;
}
a.origin-chip:hover { border-color: var(--border-strong); color: var(--fg); }
.origin-chip .ico { color: var(--faint); flex: none; }
/* An imported author is the origin's login, so it wears the origin's mark
   where a local avatar would be. */
.byline.origin-by { display: inline-flex; align-items: center; gap: 5px; }
.byline.origin-by .ico { color: var(--faint); }
.origin-link {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12.5px; color: var(--muted-fg); text-decoration: none;
}
.origin-link:hover { color: var(--accent); }

/* The origins settings page. */
.origin-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.origin-row .origin-mark .ico { color: var(--muted-fg); }
.origin-name { display: block; font-weight: 560; }
.connect-path + .connect-path { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--border); }
.connect-path h3 { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.connect-path h3 .ico { color: var(--muted-fg); }
.steps { margin: 8px 0 12px 18px; padding: 0; color: var(--muted-fg); }
.steps li + li { margin-top: 6px; }
.mirror-form { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mirror-form .input { width: 10rem; padding: 4px 8px; font-size: 13px; }

/* A device code is read aloud across a room and typed on a phone: it is the
   one place in the product where type is deliberately large. */
.device-code {
  margin: 12px 0; padding: 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--muted);
  font-family: var(--mono); font-size: clamp(24px, 6vw, 40px);
  font-variant-numeric: tabular-nums; letter-spacing: 0.14em;
  text-align: center; user-select: all; word-break: break-all;
}
/* Handing a connect to another device: a code to scan, a short link to type,
   the long one to copy. The QR keeps its own white ground in every theme —
   a scanner reads dark modules on light and refuses the inverse, so this is
   the one thing on the page the theme does not get a vote on. */
.handoff { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; margin-top: 12px; }
.handoff > svg {
  flex: none; width: 168px; height: 168px;
  background: #fff; border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.handoff-links { flex: 1 1 16rem; min-width: 0; }
.handoff-links .mono { user-select: all; overflow-wrap: anywhere; }
.break { overflow-wrap: anywhere; }

.bar > .device-code { flex: 1 1 auto; }

.repo-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }

.repo-layout { display: grid; gap: 16px; margin-top: 16px; align-items: start; }
@media (min-width: 960px) {
  .repo-layout { grid-template-columns: minmax(0, 1fr) 280px; gap: 24px; }
  .repo-layout > .about { position: sticky; top: calc(var(--topbar-h) + 16px); }
}
.about dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; margin: 0; }
.about dt { color: var(--muted-fg); }
.about dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

.issue-head { margin: 20px 0 14px; }
.issue-head h1 { font-size: clamp(20px, 1rem + 1.4vw, 26px); letter-spacing: -0.025em; }
.issue-head h1 .number { font-weight: 400; color: var(--muted-fg); }
.issue-meta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 8px; font-size: 13px; color: var(--muted-fg);
}

.tree-row { padding: 8px 14px; min-height: 36px; }
.tree-row .ico { color: var(--faint); }
.tree-row[data-kind="tree"] .ico { color: var(--accent); }

/* The file's location stays on screen while its contents scroll past. Opaque
   on purpose: code sliding under a blur is noise, not depth. */
.path-head {
  position: sticky; top: calc(var(--topbar-h) - 1px); z-index: 6;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 12px 0; padding: 8px 10px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.filters form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.filters .search { min-width: 180px; flex: 1; max-width: 320px; }

.merge-box { margin-top: 14px; }
.merge-box .card-body { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
/* Only the verdict glyph, never the merge button's own icon. */
.merge-box .card-body > .ico { margin-top: 2px; flex: none; color: var(--muted-fg); }
.merge-box[data-tone="success"] .card-body > .ico { color: var(--success); }
.merge-box[data-tone="danger"] .card-body > .ico { color: var(--danger); }
.merge-box[data-tone="merged"] .card-body > .ico { color: var(--merged); }
.merge-box .card-body > .grow { flex: 1 1 220px; }
.merge-headline { font-weight: 600; text-wrap: pretty; }
.merge-sub { color: var(--muted-fg); font-size: 13px; margin-top: 2px; text-wrap: pretty; }
.merge-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; flex: none; }
.merge-form select { min-width: 150px; width: auto; }
/* On a phone the sentence gets the width and the controls go under it, with
   the primary action full-width where the thumb already is. */
@media (max-width: 719px) {
  .merge-box .card-body > .grow { flex-basis: 100%; }
  .merge-box .merge-form, .merge-box .merge-form > form { width: 100%; }
  .merge-box .merge-form select { flex: 1 1 140px; }
  .merge-box .merge-form .btn { flex: 1 1 180px; }
}

.commit-head .card-body { padding: 14px 16px; }
.commit-body {
  white-space: pre-wrap; font-family: var(--mono); font-size: 12.5px;
  color: var(--muted-fg); margin: 8px 0 4px;
}

.fork-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }

.hero { max-width: 620px; margin: 12dvh auto 0; text-align: center; }
.hero h1 { font-size: clamp(30px, 7vw, 44px); letter-spacing: -0.04em; line-height: 1.05; }
.hero p { margin: 12px 0 24px; font-size: 16px; color: var(--muted-fg); text-wrap: pretty; }
.hero .bar { justify-content: center; }
.hero-points {
  display: grid; gap: 12px; margin-top: 40px; text-align: left;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}
.hero-points .card-body { font-size: 13px; color: var(--muted-fg); }
.hero-points strong { display: block; color: var(--fg); font-size: 14px; margin-bottom: 3px; }

/* Every page grid, in one rule: a grid item's automatic minimum size is its
   *content*, so a column with a long unbreakable line pushes the page wider
   than the phone rather than letting its own ellipsis do the work. A zero
   min-width is what makes truncation inside a grid actually truncate. */
.dash > *, .split > *, .repo-layout > *, .hero-points > * { min-width: 0; }

/* The generic two-column page: content, then a sidebar that sticks. */
.split { display: grid; gap: 16px; margin-top: 16px; align-items: start; }
@media (min-width: 960px) {
  .split { grid-template-columns: minmax(0, 1fr) 260px; gap: 24px; }
  .split > aside { position: sticky; top: calc(var(--topbar-h) + 16px); }
}

.dash { display: grid; gap: 16px; align-items: start; }
@media (min-width: 900px) { .dash { grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; } }

/* The activity rail: a sentence on top, where it happened underneath, and the
   clock beside the sentence it belongs to. */
.act .row { align-items: flex-start; padding: 10px 14px; }
.act .row-lead, .act .row-trail { margin-top: 1px; }
.act .row-title { font-weight: 400; }
.act .row-title strong { font-weight: 600; }
.act .row-trail { font-size: 12.5px; color: var(--muted-fg); font-variant-numeric: tabular-nums; }

/* ---- code view ---- */
.code { overflow-x: auto; scrollbar-width: thin; }
.code table { width: 100%; }
.code td { padding: 0 12px; vertical-align: top; }
.code tr { scroll-margin-top: calc(var(--topbar-h) + 12px); }
.code .ln {
  width: 1%; min-width: 44px; padding: 0 10px; text-align: right; user-select: none;
  color: var(--faint); font-family: var(--mono); font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  border-right: 1px solid var(--border);
}
.code .ln a { color: inherit; display: block; }
.code .ln a:hover { color: var(--accent); }
.code pre { white-space: pre; line-height: 1.55; min-height: 1.55em; font-variant-ligatures: none; }
.code tr:hover { background: color-mix(in srgb, var(--muted) 55%, transparent); }
.code tr:target, .code tr[data-hl] {
  background: color-mix(in srgb, var(--attn) 16%, transparent);
}
.code tr:target .ln, .code tr[data-hl] .ln { color: var(--attn); }

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

/* ---- prose (markdown) ---- */
.prose { padding: 16px 20px; font-size: 15px; line-height: 1.65; overflow-wrap: break-word; }
.prose > * { max-width: var(--measure); }
.prose h1, .prose h2, .prose h3, .prose h4 { margin: 24px 0 8px; }
.prose h1 { font-size: 22px; }
.prose h2 { font-size: 18px; }
.prose h3 { font-size: 15px; }
.prose h1:first-child, .prose h2:first-child, .prose h3:first-child { margin-top: 0; }
.prose h1, .prose h2 { padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.prose p, .prose ul, .prose ol, .prose blockquote { margin: 12px 0; text-wrap: pretty; }
.prose ul { list-style: disc; padding-left: 24px; }
.prose ol { list-style: decimal; padding-left: 24px; }
.prose li::marker { color: var(--faint); }
.prose pre {
  background: var(--muted); border: 1px solid var(--border);
  border-radius: var(--radius); max-width: none;
  padding: 12px 14px; overflow-x: auto; margin: 14px 0; scrollbar-width: thin;
}
.prose code { background: var(--muted); border: 1px solid var(--border); padding: 1px 5px; border-radius: 4px; }
.prose pre code { background: none; border: none; padding: 0; }
.prose blockquote {
  border-left: 3px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  padding-left: 12px; color: var(--muted-fg);
}
.prose a {
  color: var(--accent); text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent);
  text-underline-offset: 3px; transition: text-decoration-color 140ms var(--ease);
}
.prose a:hover { text-decoration-color: currentColor; }
.prose img { border-radius: var(--radius-sm); }
.prose table { width: 100%; font-size: 14px; margin: 14px 0; }
.prose th, .prose td { padding: 6px 10px; border: 1px solid var(--border); text-align: left; }
.prose hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }

/* ---- diff viewer ---- */
.diff { display: flex; flex-direction: column; gap: 12px; }
.diff-summary { padding: 10px 14px; font-size: 13px; }
.diff-summary .add { color: var(--add-fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.diff-summary .del { color: var(--del-fg); font-weight: 600; font-variant-numeric: tabular-nums; }

.diff-file {
  /* Pure-CSS windowing: off-screen files cost nothing until scrolled to. */
  content-visibility: auto;
  contain-intrinsic-size: auto 480px;
}
.diff-head {
  position: sticky; top: calc(var(--topbar-h) - 1px); z-index: 5;
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; cursor: pointer; list-style: none;
  /* Opaque: code scrolling under a blur is noise, not depth. */
  background: var(--muted); border-bottom: 1px solid var(--border);
}
.diff-head::before {
  content: ""; width: 0; height: 0; flex: none; margin-right: 2px;
  border: 4px solid transparent; border-left-color: var(--faint);
  transition: transform 160ms var(--ease);
}
.diff-file[open] > .diff-head::before { transform: rotate(90deg) translateX(1px); }
.diff-file:not([open]) > .diff-head { border-bottom: none; }
.diff-path {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12.5px; font-family: var(--mono);
}
.diff-stat {
  font-family: var(--mono); font-size: 12px; white-space: nowrap;
  font-variant-numeric: tabular-nums; display: inline-flex; gap: 6px;
}
.diff-stat .add { color: var(--add-fg); }
.diff-stat .del { color: var(--del-fg); }
.diff-note { padding: 20px 16px; text-align: center; color: var(--muted-fg); font-size: 13px; }
.diff-viewed {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  font-size: 12px; color: var(--muted-fg); cursor: pointer; margin: 0;
}
.diff-viewed input { accent-color: var(--accent); margin: 0; }
/* "Viewed" is the authority: a checked file stays collapsed and steps back,
   with no JavaScript and no server state to keep in sync. */
.diff-file:has(.diff-viewed input:checked) > .diff-head { opacity: .6; }
.diff-file:has(.diff-viewed input:checked) > .diff-body { display: none; }
.diff-file:has(.diff-viewed input:checked) > .diff-head { border-bottom: none; }

.diff-body { overflow-x: auto; scrollbar-width: thin; }
.diff-table { width: 100%; font-family: var(--mono); font-size: 12.5px; }
.diff-table td { padding: 0; vertical-align: top; }
.dn {
  width: 1%; min-width: 40px; padding: 0 8px; text-align: right;
  color: var(--faint); user-select: none;
  white-space: nowrap; border-right: 1px solid var(--border);
  font-variant-numeric: tabular-nums;
}
/* The cell never wraps; the code itself is what is pre-formatted. Keeping that on the
   inner span means a stray newline in the markup costs one collapsed space
   instead of a rendered blank line and a six-space indent. */
.dc {
  width: 100%; padding: 0 8px 0 12px; white-space: nowrap;
  border-left: 3px solid transparent;
  font-variant-ligatures: none;
}
.dcx { display: inline-block; white-space: pre; min-height: 1.5em; } /* blank lines keep height */
/* The +/-/space marker lives in ::before so selecting and copying skip it. */
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
.dh .dc { background: var(--muted); border-left-color: transparent; padding: 2px 8px 2px 12px; color: var(--muted-fg); }
.dh .dc::before { content: ""; }
.nonl { color: var(--del-fg); opacity: .7; padding-left: 8px; }
.dl:target .dc, .dl[data-hl] .dc { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--attn) 55%, transparent); }
/* line-number doubles as the comment affordance */
.dn-comment {
  color: var(--faint); display: block; position: relative;
  transition: background-color 100ms var(--ease), color 100ms var(--ease);
}
.dn-comment:hover { color: var(--accent-fg); background: var(--accent); border-radius: 4px; }
/* review comments ride under their line, full width */
.dl-review .dc-review {
  padding: 8px 12px; background: var(--muted);
  border-left: 3px solid var(--accent); white-space: normal; font-family: var(--font);
}
.rc { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; margin-bottom: 8px; }
.rc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; font-size: 13px; }
.rc-body { font-size: 13.5px; padding: 0; }
.rc-body p:first-child { margin-top: 0; }
.rc-body p:last-child { margin-bottom: 0; }
.rc-outdated { color: var(--del-fg); border-color: color-mix(in srgb, var(--del-fg) 40%, var(--border)); }
.rc-form { display: block; }
.rc-form textarea { width: 100%; }

/* A diff card is narrower inside a two-column PR page; its header wraps
   instead of squeezing the path to nothing. */
.diff-file { container-type: inline-size; }
@container (max-width: 420px) {
  .diff-head { flex-wrap: wrap; }
  .diff-stat { margin-left: auto; }
}

}
`;
