/**
 * What pages put inside the components: rendered prose, a file's source, and
 * the diff — plus the page furniture that frames them (repo
 * header, merge box, file tree). The diff is the product, so it gets the most
 * attention here: hairline gutters, an opaque sticky file header, a `+`/`−`
 * glyph that survives copy-paste, and an intra-line change signalled by two
 * channels (tint and underline) so color is never the only one.
 */

export const content = /* css */ `
@layer content {

/* ---- page furniture ---- */
.repo-head { margin: 18px 0 0; view-transition-name: repo-head; }
.repo-title {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 20px; font-weight: 620; letter-spacing: -0.02em; line-height: 1.3;
}
.repo-title .muted, .repo-title .sep { font-weight: 400; }
/* A phone has no hover: the settings link is a full 44px line. */
@media (max-width: 640px) {
  .repo-head p.muted.small a { display: block; padding: 12px 0; min-height: 44px; box-sizing: border-box; }
}
.repo-head p.muted.small { margin-top: 4px; text-wrap: pretty; }
.repo-head .tabs, .repo-head .repo-nav { margin-top: 12px; }
.repo-nav { display: flex; align-items: flex-start; gap: 4px; border-bottom: 1px solid var(--border); }
.repo-nav .tabs { margin-top: 0; border-bottom: 0; flex: 1 1 auto; }
.repo-nav .menu { margin-top: 4px; }

/* Provenance and pinning: one line under the title, so a <form> never has to
   live inside the <h1>. */
.repo-origin,
.repo-where {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 6px; min-height: 26px;
}

/* The where strip: three places, dots and words. The dot carries the state
   and the colour; the word is never coloured, so a strip reads as one fact
   rather than as three competing badges. */
.where {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  min-width: 0; font-size: 12.5px;
}
.where-place {
  display: inline-flex; align-items: center; gap: 5px;
  max-width: 100%; padding: 2px 6px; border-radius: var(--radius-sm);
  border: 1px solid transparent; background: none;
  color: var(--muted-fg); font: inherit; text-decoration: none;
  white-space: nowrap; cursor: default;
}
a.where-place, button.where-place { cursor: pointer; }
a.where-place:hover, button.where-place:hover {
  border-color: var(--border); background: var(--muted); color: var(--fg);
}
.where-place .ico { color: var(--faint); flex: none; }
/* A thumb needs more than a 12px word to land on. */
@media (pointer: coarse) { .where-place { min-height: 32px; padding: 4px 8px; } }
/* The dot is the place's aria-hidden span: ● ○ ◆ are decoration, and the
   state and the word beside them already say what they mean. */
.where-place > span[aria-hidden="true"] { font-size: var(--fs-min); line-height: 1; }
/* Accent is interaction everywhere else in the product; here it is the one
   place a page is *reading from*, which is the page's own subject. */
.where-place[data-state="reading"] { color: var(--fg); font-weight: 560; }
.where-place[data-state="reading"] > span[aria-hidden="true"] { color: var(--accent); }
.where-place[data-state="present"] > span[aria-hidden="true"] { color: var(--success); }
.where-place[data-state="absent"] { color: var(--faint); }
.where-place[data-state="absent"] > span[aria-hidden="true"] { color: var(--faint); }
.where-pin { margin-left: auto; }
/* Inside a list row the strip is text, not a layout: the row promises one
   honest line with an ellipsis, and only inline children can keep it. */
.row-meta .where { display: inline; }
.row-meta .where-place { display: inline; padding: 0; }
.row-meta .where-place .ico { display: none; }
.row-meta .where-place > span[aria-hidden="true"] { margin-right: 3px; }
.row-title a { color: inherit; text-decoration: none; }
.row-title a:hover { color: var(--accent); }
/* The signed-in home (#9378). Its rows already clip one line and its
   sections are grid cells with min-width 0 (feed_style.ts); what is left is a
   long app name, which wraps inside its chip, and the tell box's input and
   select, which may shrink. The chip row is server-rendered, so a wrapped
   chip is its final height on first paint. */
#live-chips .btn { max-width: 100%; height: auto; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.tell-box .input { min-width: 0; max-width: 100%; }
.row-trail form { display: inline-flex; }

/* "Where it lives": the origin, when it was last fetched, the button that
   fetches it now, and where a push actually lands — one block, because they
   are one fact about the repository. */
.where-block {
  margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border);
}
.where-block h3 { margin-bottom: 6px; }

/* A live browse: quiet, above the content, and never in the way of it. */
.live-note {
  display: flex; align-items: flex-start; gap: 8px;
  margin-top: 12px; padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--muted-fg); font-size: 13px;
}
.live-note .ico { color: var(--accent); flex: none; margin-top: 1px; }
.live-note p { text-wrap: pretty; }
.live-note strong { color: var(--fg); }

/* A mirror in flight. One row per stage, in the order they happen; the row
   is a §5 row whose badge says which of the three states it is in. */
.stages { list-style: none; margin: 0; padding: 0; }
.stages li[data-state="todo"] .row-title { color: var(--faint); }
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

/* Why an issue closes, beside the button that closes it. */
.form-actions select[name="reason"] { width: auto; }
.form-actions input[name="into"] { display: none; width: 7em; }
.form-actions:has(select[name="reason"] option[value="split"]:checked) input[name="into"] { display: inline-block; }
/* On a phone the Markdown hint takes its own line, so the reason, Close and
   Comment stay together on the next one instead of Comment wrapping alone. */
@media (max-width: 480px) {
  .comment-form .form-actions > .muted.small { flex-basis: 100%; }
  .comment-form .form-actions > .spacer { display: none; }
  .comment-form .form-actions > :last-child { margin-left: auto; }
  /* The reason select, Close and Comment must fit 332 px with room to
     spare: a tighter gap and a narrower select. */
  .comment-form .form-actions { gap: 6px; }
  .comment-form .form-actions select[name="reason"] { padding-inline: 8px 24px; max-width: 84px; }
  /* Words carry the buttons here; their icons give back the width a 360 px
     row needs for "Close issue", and the buttons keep their full height. */
  .comment-form .form-actions .btn .ico { display: none; }
}

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
[data-apps], [data-bet-card], [data-milestone], [data-now] { overflow-wrap: anywhere; }
[data-bet-card] h2, [data-bet-card] ul, [data-bet-card] p { margin-block: 8px; }
[data-bet-card] ul { padding-inline-start: 16px; }
[data-bet-card] { max-height: 80vh; overflow-x: hidden; overflow-y: auto; }
[data-bet-actions] { align-items: flex-start; }

.bar > .device-code { flex: 1 1 auto; }

.repo-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }


/* A list's six words fit a phone without pushing the page sideways in a
   filter bar drawn with §5's .bar: a little less padding there, and a
   scroll inside the bar as the last resort. */
.bar .seg { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
@media (max-width: 420px) { .bar .seg > a { padding: 0 8px; } }

.direction-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; color: var(--muted-fg); margin: 6px 0 0; }

.chart-box { color: var(--accent); aspect-ratio: 720 / 260; max-width: 720px; }
.chart-box .chart { display: block; width: 100%; height: auto; }
.chart-box text { fill: var(--muted-fg); font-family: var(--mono); }
.chart-box circle { fill: var(--accent); }
.chart-box .big { fill: var(--fg); font-family: inherit; }
.chart-box.is-table { aspect-ratio: auto; height: 260px; overflow: auto; }
/* A board panel sizes its chart from here, after .chart-box: the grid itself
   is §5's board (components.ts), but this layer is where .chart-box is drawn. */
.bgrid .chart-box { max-width: none; }
.bp-h2 .chart-box { aspect-ratio: 720 / 400; }
.bp-h3 .chart-box { aspect-ratio: 720 / 540; }
.bp-h2 .chart-box.is-table { height: 400px; }
.bp-h3 .chart-box.is-table { height: 540px; }
#summary { display: flex; flex-wrap: wrap; gap: 6px; }
#summary .pill { max-width: 100%; white-space: normal; }
/* The stacked bar chart's series colours, for its bars (fleet-graph.ts).
   Okabe–Ito, told apart with common colour-vision deficiencies; the eighth,
   the folded "others", is grey. */
.fg-s0 { fill: var(--series-0); color: var(--series-0); }
.fg-s1 { fill: var(--series-1); color: var(--series-1); }
.fg-s2 { fill: var(--series-2); color: var(--series-2); }
.fg-s3 { fill: var(--series-3); color: var(--series-3); }
.fg-s4 { fill: var(--series-4); color: var(--series-4); }
.fg-s5 { fill: var(--series-5); color: var(--series-5); }
.fg-s6 { fill: var(--series-6); color: var(--series-6); }
.fg-s7 { fill: var(--series-7); color: var(--series-7); }
.restore-command { margin: 8px 0 0; padding: 8px 10px; font-size: 12.5px; white-space: pre-wrap; word-break: break-all; background: var(--muted); border-radius: var(--radius); }
form.inline { display: inline; margin-left: auto; }

/* The studio's front door: the public apps, live first, as pictures. */
.stack[data-shelf] {
  display: grid; gap: 16px; max-width: 1040px; margin-inline: auto;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}

.front-admin { max-width: 1040px; margin-inline: auto; }
.front-pick { gap: 8px; }
.front-pick form.inline { margin-left: 0; }
.card[data-front-settings] .bar { padding: 12px 16px; gap: 8px 12px; }
.card[data-front-settings] .bar:has(> [name=repo]) { flex-wrap: nowrap; }
.card[data-front-settings] .bar > [name=repo] { flex: 1; min-width: 0; }
.card[data-front-settings] label .input { width: 4.5em; margin-left: 4px; }
.card[data-front-settings] .small { padding: 0 16px 14px; }
@media (max-width: 520px) {
  /* Two to a row on a phone: a few live apps in one screen, not a scroll. */
  .stack[data-shelf] { gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* Every page grid, in one rule: a grid item's automatic minimum size is its
   *content*, so a column with a long unbreakable line pushes the page wider
   than the phone rather than letting its own ellipsis do the work. A zero
   min-width is what makes truncation inside a grid actually truncate. */
.split > * { min-width: 0; }
.split { grid-template-columns: minmax(0, 1fr); }

/* The generic two-column page: content, then a sidebar that sticks. */
.split { display: grid; gap: 16px; margin-top: 16px; align-items: start; }
@media (min-width: 960px) {
  .split { grid-template-columns: minmax(0, 1fr) 260px; gap: 24px; }
  .split > aside { position: sticky; top: calc(var(--topbar-h) + 16px); }
}

/* The studio's wide rail (home, an app): a column of cards that runs taller
   than a screen, so it scrolls with the page instead of sticking, sits flush
   under the tabs or header, and takes its two columns from 900px. */
.split[data-rail="wide"] { margin-top: 0; }
@media (min-width: 900px) {
  .split[data-rail="wide"] { grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; }
  .split[data-rail="wide"] > aside { position: static; }
}

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

/* ---- csv view: the header stays under the bar, the first column on phones ---- */
.csv-tools { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.csv-tools[hidden], .csv-view tr[hidden] { display: none; }
.csv-tools .input { max-width: 260px; }
.csv-scroll { overflow: auto; max-height: 75vh; scrollbar-width: thin; }
.csv-view th { position: sticky; top: 0; z-index: 2; background: var(--card); user-select: none; }
.csv-sort {
  font: inherit; color: inherit; background: none; border: 0; padding: 0;
  text-align: inherit; cursor: pointer;
}
.csv-sort:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.csv-view th:first-child { z-index: 3; }
.csv-view td { max-width: 40ch; overflow-wrap: anywhere; }
.csv-view th[aria-sort="ascending"]::after { content: " \\25B2"; font-size: 12.5px; }
.csv-view th[aria-sort="descending"]::after { content: " \\25BC"; font-size: 12.5px; }
.csv-view .num { text-align: right; }
.csv-more { padding: 10px 12px; margin: 0; }

/* ---- syntax tokens (colors come from the active theme) ----
   Two layers, exactly as the tokenizer emits them: a colour class every
   consumer understands, and — where the web can say something finer — a kind
   painted over it: .tok-string.tok-regex is a regex, and dropping the second
   class leaves a string. Order matters and specificity does not: the kind
   rules come last, so they win at equal weight. */
.tok-keyword { color: var(--tok-keyword); }
.tok-string { color: var(--tok-string); }
.tok-comment { color: var(--tok-comment); font-style: italic; }
.tok-number { color: var(--tok-number); }
.tok-function { color: var(--tok-function); }
.tok-type { color: var(--tok-type); }
.tok-constant { color: var(--tok-constant); }
.tok-meta { color: var(--tok-meta); }
/* Punctuation and operators sit *below* the text colour on purpose: they are
   the scaffolding of a line, and colouring them loudly makes code shout. */
.tok-operator { color: var(--tok-operator); }
.tok-punctuation { color: var(--tok-punctuation); }
/* the refinements */
.tok-property { color: var(--tok-property); }
.tok-tag { color: var(--tok-tag); }
.tok-attribute { color: var(--tok-attribute); }
.tok-regex { color: var(--tok-regex); }
.tok-variable { color: var(--tok-variable); }
.tok-decorator { color: var(--tok-decorator); }
.tok-heading { color: var(--tok-heading); font-weight: 600; }
.tok-emphasis { color: var(--tok-emphasis); font-style: italic; }
.tok-link { color: var(--tok-link); }
.tok-inserted { color: var(--add-fg); }
.tok-deleted { color: var(--del-fg); }

/* A rendered Markdown blob wears the same frame its source does: one card,
   one path header, and the switch between the two views in it. */
.blob-view { margin-left: 8px; }
.blob-view .seg { font-size: 12.5px; }
/* An audio or video file, played inline (render/player.ts). The video is as
   wide as the pane and no wider; height follows its own aspect ratio. */
.media-pane .media-player { display: block; width: 100%; max-width: 100%; }
.media-pane video.media-player { height: auto; max-height: 80vh; background: var(--muted); border-radius: var(--radius-sm); }

/* A PDF in the browser's own viewer: a fixed frame, so nothing shifts. */
.pdf-view { overflow: hidden; }
.pdf-frame { display: block; width: 100%; height: 80vh; min-height: 480px; border: 0; }
.pdf-fallback { padding: 16px 20px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
/* A phone: a shorter frame, so a thumb can scroll the page past it. */
@media (max-width: 600px) { .pdf-frame { height: 60vh; min-height: 360px; } }

/* ---- image view ---- */
.imgview-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 4px 16px; font-size: 12.5px; border-bottom: 1px solid var(--border); }
.imgview-dim { min-width: 9ch; }
.imgview-pane { overflow: auto; min-height: 160px; max-height: 80vh; text-align: center; padding: 12px;
  background: repeating-conic-gradient(color-mix(in srgb, var(--fg) 8%, var(--bg)) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
.imgview-zoom { margin-left: auto; }
.imgview-img { max-width: 100%; height: auto; cursor: zoom-in; vertical-align: middle; }
.imgview-pane.is-actual { text-align: left; cursor: grab; }
.imgview-pane.is-actual .imgview-img { max-width: none; cursor: zoom-out; }

/* ---- prose (markdown) ---- */
.prose { padding: 16px 20px; font-size: 15px; line-height: 1.65; overflow-wrap: anywhere; }
.prose > * { max-width: var(--measure); }
.prose h1, .prose h2, .prose h3, .prose h4 { margin: 24px 0 8px; }
.prose h1 { font-size: 20px; }
.prose h2 { font-size: 16px; }
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
/* Written text kept as typed (a commit message, a report): plain muted mono, wraps, never scrolls sideways. */
.prose[data-text="message"] { padding: 0; margin: 8px 0 4px; font-size: 12.5px; line-height: 1.5; }
.prose[data-text="message"] pre {
  background: none; border: 0; border-radius: 0; padding: 0; margin: 0;
  font-family: var(--mono); color: var(--muted-fg);
  white-space: pre-wrap; overflow-wrap: anywhere; overflow: visible;
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
.prose th { background: var(--muted); font-weight: 600; }
.prose .ta-c { text-align: center; }
.prose .ta-r { text-align: right; }
.prose hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }

/* ---- diff viewer ---- */
.diff { display: flex; flex-direction: column; gap: 12px; }
.change-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin: 0 0 12px; font-size: 13px; }
.change-line a { display: inline-flex; align-items: center; gap: 6px; padding: 12px 0; line-height: 16px; color: inherit; }
.change-files { list-style: none; margin: 0 0 12px; padding: 0; font-size: 13px; }
.change-files li { display: flex; flex-wrap: wrap; gap: 0 8px; align-items: center; }
.change-files a { padding: 12px 0; line-height: 16px; color: inherit; overflow-wrap: anywhere; }
@media (pointer: coarse) { .change-line a, .change-files a { padding: 14px 0; } }
.diff-summary { padding: 10px 14px; font-size: 13px; }
.diff-summary .add, .change-line .add, .change-files .add { color: var(--add-fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.diff-summary .del, .change-line .del, .change-files .del { color: var(--del-fg); font-weight: 600; font-variant-numeric: tabular-nums; }

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
  font-family: var(--mono); font-size: 12.5px; white-space: nowrap;
  font-variant-numeric: tabular-nums; display: inline-flex; gap: 6px;
}
.diff-stat .add { color: var(--add-fg); }
.diff-stat .del { color: var(--del-fg); }
.diff-note { padding: 20px 16px; text-align: center; color: var(--muted-fg); font-size: 13px; }
.diff-stub p { margin: 0 0 10px; }
.diff-stub .diff-stat { display: inline-flex; }
.diff-viewed {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  font-size: 12.5px; color: var(--muted-fg); cursor: pointer; margin: 0;
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
.dc-review {
  padding: 8px 12px; background: var(--muted);
  border-left: 3px solid var(--accent); white-space: normal; font-family: var(--font);
}
.dc-review .card + .card, .dc-review .comment { margin-bottom: 8px; }
.dc-review .comment-form { margin-top: 0; }
/* A settled thread is one line plus a disclosure: the point of resolving is
   to get an answered question out of the way of the unanswered ones. */
.dc-review .card-body > .muted .ico { width: 14px; height: 14px; color: var(--success); }

/* ---- review verdicts ---- */
/* A verdict passed before the latest push is history, not a position: it
   keeps its words and loses its colour. */
.verdict-stale { color: var(--muted-fg); background: none; }
.verdict-stale .ico { width: 12px; height: 12px; }
.review-card .review-verdicts { border: 0; padding: 0; margin: 0; display: grid; gap: 10px; }
.review-verdicts .check .hint {
  display: block; font-size: 12.5px; color: var(--muted-fg); margin-top: 1px;
}
.review-card textarea { width: 100%; }
.reviews-chip {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-top: 6px; font-size: 13px; color: var(--muted-fg);
}
.reviews-chip .ico { width: 14px; height: 14px; }
.reviews-chip .ok { display: inline-flex; align-items: center; gap: 4px; color: var(--success); }
.reviews-chip .bad { display: inline-flex; align-items: center; gap: 4px; color: var(--danger); }

/* ---- apps, runs, and the crew ---- */
/* The strip a repo home wears when it runs: state, commit, URL, previews,
   and the way to the App page — one line, in the repo header's own voice. */
.app-strip {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-top: 12px; padding: 8px 12px; font-size: 13px;
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
}
.app-strip > .ico { color: var(--muted-fg); flex: none; }
.app-strip .spacer { flex: 1; }
/* One environment: name and state in the head, the facts and the reason it
   failed in the body. A card rather than a row so a deploy error has a whole
   line to be read on. The facts and the error read the same wherever they
   are shown — a pull's preview, the studio head — so they are not scoped to
   the card. */
.env-card .card-head { gap: 10px; }
.env-facts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--muted-fg); overflow-wrap: anywhere; }
.env-error { color: var(--danger); font-size: 13px; margin-top: 6px; overflow-wrap: anywhere; text-wrap: pretty; }
/* The checks line inside the merge box, in the reviews chip's voice. */
.checks-line {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-top: 6px; font-size: 13px; color: var(--muted-fg);
}
.checks-line .ico { width: 14px; height: 14px; }
.checks-line .ok { display: inline-flex; align-items: center; gap: 4px; color: var(--success); }
.checks-line .bad { display: inline-flex; align-items: center; gap: 4px; color: var(--danger); }
.checks-line .now { display: inline-flex; align-items: center; gap: 4px; color: var(--attn); }
.check-words { margin: 4px 0 0; min-height: 1.4em; }
/* Reserved only while the run is open: pins arriving never move the log. */
/* A plain block, not .stack: a flex column would shrink the clipped cards to fit 9em. */
[data-pins] { max-height: 9em; overflow-y: auto; }
[data-check-progress][data-state="queued"] [data-pins], [data-check-progress][data-state="running"] [data-pins] { height: 9em; }
[data-pins] .card + .card { margin-top: 12px; }
[data-pins] pre { margin: 4px 0 0; white-space: pre-wrap; font-size: var(--fs-min); }
/* A run, live: a transcript with a speaker column, bounded so the page
   head stays reachable, and a composer that sits under it. */
#run-live { position: relative; }
.run-log {
  margin: 0; padding: 10px 14px 8px; max-height: calc(100dvh - 300px); min-height: 12em; overflow: auto;
  background: var(--muted); border: 1px solid var(--border); border-radius: var(--radius);
  font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; tab-size: 4;
}
#run-live:has(#run-steer) .run-log { border-radius: var(--radius) var(--radius) 0 0; }
.run-log .row { padding: 2px 0; min-height: 0; align-items: flex-start; }
.run-log .row-lead { flex: 0 0 72px; justify-content: flex-start; overflow: hidden; }
.run-log .row-lead .badge { overflow: hidden; text-overflow: ellipsis; }
.run-log .row-title { font-weight: 400; white-space: pre-wrap; overflow: visible; }
.run-log [data-line="tool"] .row-title { font-family: var(--mono); font-size: 12.5px; color: var(--faint); }
.run-log [data-line="tool"] b { color: var(--fg); font-weight: 600; }
.run-log [data-line="forge"] .row-title { color: var(--faint); font-style: italic; }
.run-log [data-line="pulse"] i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--faint); margin-right: 4px; animation: run-pulse 1.2s infinite ease-in-out; }
.run-log [data-line="pulse"] i:nth-child(2) { animation-delay: .2s; }
.run-log [data-line="pulse"] i:nth-child(3) { animation-delay: .4s; }
@keyframes run-pulse { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
#run-jump {
  position: sticky; bottom: 6px; float: right; margin-top: 6px; border-radius: 999px; box-shadow: var(--shadow-2);
}
#run-steer {
  position: sticky; bottom: 0; gap: 6px; padding: 10px 12px; background: var(--bg);
  border-top: 0; border-radius: 0 0 var(--radius) var(--radius); box-shadow: none;
}
#run-steer textarea { min-height: 38px; max-height: 160px; resize: none; }
#run-steer .bar .muted { flex: 1 1 200px; }
/* A tail beside a running row (studio/app.ts): the same log, a peek at it
   — fixed height so nothing around it shifts as lines arrive, and it
   scrolls itself rather than the page. */
.run-log.log-tail { max-height: 8.5em; min-height: 0; margin: 6px 0 0; font-size: 12.5px; }
.table .truncate { max-width: 34ch; display: inline-block; vertical-align: bottom; }

/* ---- proposing a change ---- */
/* The editor's commit block, when the commit is a contribution: the whole
   outcome in one sentence before anybody types. */
.editor-target.propose > legend { display: inline-flex; align-items: center; gap: 6px; }
.propose-line { margin: 0 0 14px; text-wrap: pretty; }
.propose-line .hint { display: block; margin-top: 2px; font-size: 12.5px; color: var(--muted-fg); }
/* The commit block's inputs sit inline beside a radio; the propose card's
   are ordinary fields, and want the full column. */
.editor-target.propose .input {
  display: block; width: 100%; min-width: 0; margin-left: 0;
}

/* A diff card is narrower inside a two-column PR page; its header wraps
   instead of squeezing the path to nothing. */
.diff-file { container-type: inline-size; }
@container (max-width: 420px) {
  .diff-head { flex-wrap: wrap; }
  .diff-stat { margin-left: auto; }
}

/* ---- the code browser: explorer beside content ---- */
/* One grid, two behaviours. Below 900px the explorer is the "Files" drawer
   above the content and its <summary> is the handle; above it, the summary
   goes away and the column simply is. The element is always [open], so no
   layout depends on a script having toggled anything.

   Above 900px there are three columns: the tree, the divider, the file. The
   tree's width is one custom property, \`--ex-w\`, so the divider's script
   has exactly one thing to set and the stylesheet keeps the fallback. */
.code-layout { display: grid; gap: 12px; margin-top: 12px; align-items: start; }
.code-layout > #code-main { min-width: 0; }
.code-layout > #code-main[aria-busy="true"] { opacity: .55; transition: opacity 120ms var(--ease); }
/* The divider is nothing until a script can drag it, and nothing on one
   column either. */
.code-layout > [data-split] { display: none; }

.explorer-panel { min-width: 0; }
.explorer-panel:not([open]) > summary { border-radius: var(--radius-sm); }
.explorer-panel > summary {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--card); font-weight: 550; list-style: none;
}
.explorer-panel > summary::-webkit-details-marker { display: none; }
.explorer-panel > summary .ico { color: var(--faint); }
.explorer-panel > summary .mono { font-size: 12.5px; }
.explorer-panel[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }

.explorer {
  border: 1px solid var(--border); border-top: none;
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  background: var(--card);
  max-height: 45dvh; overflow: auto; overscroll-behavior: contain;
  scrollbar-width: thin;
  padding: 4px 0 8px;
}
.explorer > div { display: flex; gap: 6px; padding: 6px 8px; flex-wrap: wrap; }
.explorer > div .btn { flex: 1; justify-content: flex-start; }

.explorer ul { margin: 0; padding: 0; list-style: none; }
.explorer ul ul { padding-left: 12px; border-left: 1px solid var(--border); margin-left: 10px; }
.ex-file, .ex-dir > summary, .ex-more {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 10px; min-height: 26px;
  font-size: 13px; color: var(--muted-fg);
  overflow: hidden; cursor: pointer; list-style: none;
}
.ex-dir > summary::-webkit-details-marker { display: none; }
@media (pointer: coarse) { .ex-file, .ex-dir > summary, .ex-more { min-height: 44px; } }
.explorer ul .ico { color: var(--faint); flex: none; width: 14px; height: 14px; }
.ex-dir > summary > .ico { transition: transform 120ms var(--ease); }
.ex-dir[open] > summary > .ico { transform: rotate(90deg); }
.ex-dir > summary { font-weight: 500; color: var(--fg); }
.ex-file:hover, .ex-dir > summary:hover, .ex-more:hover { background: var(--muted); color: var(--fg); }
.ex-file[aria-current="page"] {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--fg); font-weight: 550;
}
.ex-file:focus-visible { outline-offset: -2px; }
.ex-dir > summary[data-current] { color: var(--accent); }
.ex-more { color: var(--accent); font-size: 12.5px; }
.explorer li > .muted { display: block; padding: 3px 10px 3px 16px; font-size: 12.5px; color: var(--faint); }

@media (min-width: 900px) {
  .code-layout {
    grid-template-columns: minmax(0, var(--ex-w, 260px)) auto minmax(0, 1fr);
    gap: 0 6px;
  }
  /* The tree stays put while the file scrolls past. Sticky needs a parent
     as tall as the row to move within, so the panel stretches to the row
     and the details' content box stretches to the panel — all three rules
     only work together. */
  .explorer-panel { align-self: stretch; }
  /* On a wide screen the column is not a disclosure at all — it just is.
     Where this pseudo-element is understood the handle goes away too; where
     it is not, the handle stays and one click opens the column, which is why
     the element ships closed rather than open. */
  .explorer-panel::details-content {
    content-visibility: visible; block-size: auto; min-block-size: 100%;
  }
  .explorer {
    border-top: 1px solid var(--border); border-radius: var(--radius);
    position: sticky; top: calc(var(--topbar-h) + 12px);
    max-height: calc(100dvh - var(--topbar-h) - 32px);
  }
  /* The divider: a 12px lane with a hairline down its middle, sticky to the
     same band as the tree so there is always something to grab. The line
     thickens and takes the accent under the pointer, on focus and while
     dragging; the lane itself stays transparent. */
  :root.js .code-layout > [data-split] {
    display: block; position: sticky; align-self: stretch;
    top: calc(var(--topbar-h) + 12px);
    max-height: calc(100dvh - var(--topbar-h) - 32px);
    width: 12px; cursor: col-resize; touch-action: none;
    border-radius: var(--radius-sm);
  }
  .code-layout > [data-split]::before {
    content: ""; position: absolute; inset: 0 -4px;
  }
  .code-layout > [data-split]::after {
    content: ""; position: absolute; top: 0; bottom: 0; left: 50%;
    width: 1px; margin-left: -0.5px; background: var(--border);
    transition: background-color 120ms var(--ease), width 120ms var(--ease), margin-left 120ms var(--ease);
  }
  .code-layout > [data-split]:hover::after, .code-layout > [data-split]:focus-visible::after, .code-layout[data-dragging] > [data-split]::after {
    width: 3px; margin-left: -1.5px; background: var(--accent);
  }
  .code-layout > [data-split]:focus-visible { outline-offset: 0; }
  /* While a drag is on, nothing beneath the pointer may select or steal
     the cursor. */
  .code-layout[data-dragging] { cursor: col-resize; user-select: none; -webkit-user-select: none; }
  .code-layout[data-dragging] > #code-main, .code-layout[data-dragging] .explorer-panel { pointer-events: none; }
}
@supports selector(::details-content) {
  @media (min-width: 900px) {
    .explorer-panel > summary { display: none; }
  }
}
@media (min-width: 900px) and (pointer: coarse) {
  /* A finger needs 44px: the lane keeps its width and the hit area grows
     under it, into the padding on either side. */
  .code-layout > [data-split]::before { inset: 0 -16px; }
}
@media (min-width: 1200px) {
  .code-layout { grid-template-columns: minmax(0, var(--ex-w, 300px)) auto minmax(0, 1fr); }
}

/* ---- the finder ---- */
.finder { width: min(720px, calc(100vw - 24px)); }
@media (max-width: 719px) { .finder { width: 100%; max-width: 100%; } }
.finder .palette-item .cat {
  font-family: var(--mono); font-size: var(--fs-min);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%;
}
.finder .palette-item .grow { font-family: var(--mono); font-size: 12.5px; }

/* ---- the editor ---- */
.editor-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 12px 0 0; padding: 8px 10px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}
.editor-head input[name="path"] { flex: 1 1 16rem; min-width: 0; }
.editor-head .btn[aria-selected="true"] { color: var(--fg); font-weight: 550; }

.editor-wrap {
  display: flex; align-items: stretch;
  border: 1px solid var(--border); border-top: none;
  border-radius: 0 0 var(--radius) var(--radius);
  background: var(--card); overflow: hidden;
  /* The ceiling lives here, on the thing that holds all three layers, so the
     gutter, the mirror and the textarea are always exactly as tall as each
     other and scroll as one. */
  max-height: 70dvh;
}
.editor-gutter {
  flex: none; width: 3.5rem; padding: 10px 8px 10px 0;
  text-align: right; user-select: none;
  font-family: var(--mono); font-size: var(--editor-fs); line-height: 1.55;
  color: var(--faint); background: var(--muted);
  border-right: 1px solid var(--border);
  overflow: hidden;
}
.editor-gutter span { display: block; }

/* The overlay. The mirror holds the syntax-coloured text and the textarea
   sits on top of it with transparent text and a visible caret, so one grid
   cell and one set of metrics serve both — any divergence in font, padding,
   line height or tab size would put the caret in the wrong place. Neither
   wraps: the editor scrolls horizontally instead of reflowing, which is what
   a code editor does. */
.editor-wrap > div:last-child {
  position: relative; display: grid; flex: 1; min-width: 0; min-height: 0;
}
#editor-mirror,
textarea.editor {
  grid-area: 1 / 1;
  margin: 0; border: none; background: none;
  padding: 10px 12px; min-height: 14rem;
  font-family: var(--mono); font-size: var(--editor-fs); line-height: 1.55;
  tab-size: 2; white-space: pre;
  overflow: auto;
}
.editor-wrap[data-mirrored] #editor-mirror,
.editor-wrap[data-mirrored] textarea.editor { min-height: 0; }
textarea.editor { resize: vertical; field-sizing: content; }
textarea.editor:focus-visible { outline: none; }
#editor-mirror {
  overflow: hidden; pointer-events: none; user-select: none;
  color: var(--fg);
}
/* Only when the mirror is live does the textarea's own text step aside — with
   no script (or no bundle) the plain textarea is what you see. */
.editor-wrap:not([data-mirrored]) #editor-mirror { display: none; }
.editor-wrap[data-mirrored] textarea.editor {
  color: transparent;
  caret-color: var(--fg);
  -webkit-text-fill-color: transparent;
}
.editor-wrap[data-mirrored] textarea.editor::selection {
  background: color-mix(in srgb, var(--accent) 30%, transparent);
}
#editor-mirror > div {
  display: block; min-height: 1.55em; min-width: 100%; width: max-content;
}
#editor-mirror > [aria-current] {
  background: color-mix(in srgb, var(--muted) 75%, transparent);
}
.editor-wrap { --editor-fs: 12.5px; }
.editor-wrap:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
/* Touch screens zoom a field set under 16px; the gutter, mirror and textarea share the size so they stay aligned. */
@media (pointer: coarse) { .editor-wrap { --editor-fs: 16px; } }
/* The ring above is a shadow, which forced colours drop; the textarea's own outline is off, so draw one. */
@media (forced-colors: active) { .editor-wrap:focus-within { outline: 2px solid Highlight; outline-offset: 2px; } }
#editor-preview {
  border: 1px solid var(--border); border-top: none;
  border-radius: 0 0 var(--radius) var(--radius);
  background: var(--card); min-height: 12rem;
}
.editor-commit { margin-top: 12px; }
.editor-target { border: 0; padding: 0; margin: 4px 0 0; }
.editor-target legend { font-weight: 600; margin-bottom: 6px; }
.editor-target .check { display: flex; }
.editor-target .check + .check { margin-top: 10px; }
.editor-target .check .hint { display: block; font-size: 12.5px; color: var(--muted-fg); }
.editor-target .input { display: inline-block; width: auto; min-width: 14rem; margin-left: 6px; }
.editor-target .input:disabled { opacity: .55; }
#f-pull-block { margin: 12px 0 0 26px; padding-left: 12px; border-left: 2px solid var(--border); }
#f-pull-block .field { margin-bottom: 10px; }

/* ---- branches ---- */
.branch-row .row-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.branch-div { display: inline-flex; gap: 8px; font-size: 12.5px; }
.branch-div .ahead { color: var(--add-fg); }
.branch-div .behind { color: var(--del-fg); }

/* ---- search results ---- */
.code-hit .row-title { font-size: 12.5px; }
.code-line {
  font-size: 12.5px; white-space: pre; overflow-x: auto;
  scrollbar-width: none; color: var(--muted-fg);
}
.code-line::-webkit-scrollbar { display: none; }
.code-line mark, .row-title mark {
  background: color-mix(in srgb, var(--attn) 35%, transparent);
  color: var(--fg); border-radius: 2px; padding: 0 1px;
}

}
/* What needs you, pinned on the home: the bulk step's select as wide as
   its words, not the column. */
#needs-you #asks-bulk select { width: auto; max-width: 100%; }
#needs-you #asks-bulk .input[name="reason"] { flex: 1 1 12rem; width: auto; min-width: 0; }
/* A phone shows the top asks and one "N more" that opens in place to all
   of them; a wider screen shows ASKS_SHOWN and its own "N more" past that.
   Only where a details element can be held open: elsewhere both summaries
   stay, so every ask is still a tap away. */
@supports selector(::details-content) {
  @media (max-width: 480px) {
    #needs-you #asks-more > summary { display: none; }
    #needs-you #asks-more::details-content { content-visibility: visible; }
    #needs-you #asks-more > .stack { margin-top: 0; }
  }
  @media (min-width: 481px) {
    #needs-you #asks-phone-more > summary { display: none; }
    #needs-you #asks-phone-more::details-content { content-visibility: visible; }
    #needs-you #asks-phone-more > .stack { margin-top: 0; }
  }
}
/* Flow (#8698): the week's pipes. Width is spend; a valve is drawn open,
   half-open (a share) or shut, in tokens. */
.pipes { width: 100%; height: auto; display: block; }
.pipe { fill: none; stroke: currentColor; opacity: .5; }
.pipe-out { color: var(--series-3); }
.pipe-out.pipe-valve-shut { stroke-dasharray: 4 4; opacity: .35; }
.pipe-valve rect { fill: var(--bg); stroke: var(--border); stroke-width: 1.5; }
.pipe-valve-share rect { stroke: var(--series-1); }
.pipe-valve-shut rect { stroke: var(--series-5); fill: var(--bg); }
.pipe-label { font-size: 12.5px; fill: var(--fg); }
.pipe-repo { font-size: 12.5px; fill: var(--muted-fg); }
.valve-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 4px 0; }
/* A valve row's name and body are sentences, not one clipped line (#9323): they wrap inside the row. */
.valve-name, .valve-body { white-space: normal; overflow-wrap: anywhere; }
.valve-name, .valve-body { display: block; }
.valve-range { flex: 1 1 12rem; min-width: 8rem; }
/* The week on Next up (#8704): the cut line and a row's cost range. */
.next-week { opacity: 0.55; }
.cut-line { list-style: none; padding: 6px 16px; font-size: 13px; color: var(--muted-fg); border-top: 2px dashed var(--series-1); border-bottom: 1px solid var(--border); background: var(--bg); }
.estimate { color: var(--fg); font-variant-numeric: tabular-nums; }
/* The config form (#7336): nested objects as quiet fieldsets, scalar
   arrays as a wrapping row of chips, object arrays as cards. */
.config-group { border-left: 2px solid var(--border); padding-left: 12px; }
.config-group > legend { font-weight: 600; margin-bottom: 8px; }
.config-card { padding: 12px; margin: 0 0 12px; }
.config-chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.config-chips > li { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.config-chips .input { width: auto; min-width: 8rem; }
.config-chips .field { margin: 0; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.config-diff { overflow-x: auto; white-space: pre; padding: 12px; }
.config-diff > [data-op="add"] { background: var(--add-bg); color: var(--add-fg); }
.config-diff > [data-op="del"] { background: var(--del-bg); color: var(--del-fg); }
/* Reduced motion: the pulses hold still at a legible level, the scroll-tied
   fade stays at its resting width, and these transitions land at once. */
@media (prefers-reduced-motion: reduce) {
  .run-log [data-line="pulse"] i { animation: none; }
  .run-log [data-line="pulse"] i { opacity: .6; }
  .ex-dir > summary > .ico, .code-layout > #code-main[aria-busy="true"], .code-layout > [data-split]::after { transition: none; }
}
`;
