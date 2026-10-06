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
.where-sep { color: var(--faint); }
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
.where-dot { font-size: 10px; line-height: 1; }
.where-note { color: var(--faint); }
/* Accent is interaction everywhere else in the product; here it is the one
   place a page is *reading from*, which is the page's own subject. */
.where-place[data-state="reading"] { color: var(--fg); font-weight: 560; }
.where-place[data-state="reading"] .where-dot { color: var(--accent); }
.where-place[data-state="present"] .where-dot { color: var(--success); }
.where-place[data-state="absent"] { color: var(--faint); }
.where-place[data-state="absent"] .where-dot { color: var(--faint); }
.where-pin { margin-left: auto; }
/* Inside a list row the strip is text, not a layout: the row promises one
   honest line with an ellipsis, and only inline children can keep it. */
.row-meta .where { display: inline; }
.row-meta .where-place { display: inline; padding: 0; }
.row-meta .where-place .ico { display: none; }
.row-meta .where-dot { margin-right: 3px; }
.row-meta .where-sep { margin: 0 3px; }
.row-title a { color: inherit; text-decoration: none; }
.row-title a:hover { color: var(--accent); }
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
   says which of the three states it is in and nothing else moves. */
.stages { list-style: none; margin: 0; padding: 0; }
.stages li {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0; font-size: 13.5px; color: var(--faint);
}
.stages li + li { border-top: 1px solid var(--border); }
.stages li[data-state="done"] { color: var(--muted-fg); }
.stages li[data-state="done"] .stage-dot { color: var(--success); }
.stages li[data-state="now"] { color: var(--fg); font-weight: 560; }
.stages li[data-state="now"] .stage-dot { color: var(--accent); }
.stages li[data-state="failed"] { color: var(--danger); }
.stages li[data-state="failed"] .stage-dot { color: var(--danger); }
.stage-dot { flex: none; width: 16px; text-align: center; }
.stage-detail { margin-left: auto; color: var(--faint); font-size: 12.5px; font-weight: 400; }
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
/* The two OAuth paths, folded away. Both need somebody to register an
   application once, and a page whose first control cannot be used until an
   operator sets an environment variable teaches people the product is
   fiddly — so the path that always works is open and these are one click. */
.connect-more { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
.connect-more > summary {
  cursor: pointer; font-weight: 560; list-style: none;
  display: flex; align-items: center; gap: 6px;
}
.connect-more > summary::-webkit-details-marker { display: none; }
.connect-more > summary::before {
  content: "›"; display: inline-block; color: var(--faint);
  transition: transform 120ms var(--ease);
}
.connect-more[open] > summary::before { transform: rotate(90deg); }
.connect-more > summary:hover { color: var(--accent); }
.connect-more > p { margin: 6px 0 4px; }
/* A page's quiet Details: what a person sometimes changes, closed until
   asked for, the same disclosure as the one above. */
.quiet-details > summary {
  cursor: pointer; font-weight: 560; list-style: none; color: var(--muted-fg);
  display: flex; align-items: center; gap: 6px; padding: 6px 0;
}
.quiet-details > summary::-webkit-details-marker { display: none; }
.quiet-details > summary::before {
  content: "›"; display: inline-block; color: var(--faint);
  transition: transform 120ms var(--ease);
}
.quiet-details[open] > summary::before { transform: rotate(90deg); }
.quiet-details > summary:hover { color: var(--accent); }
/* Why an issue closes, beside the button that closes it. */
.form-actions .close-reason { width: auto; min-height: 32px; padding-block: 0; }
.form-actions .close-into { display: none; width: 7em; min-height: 32px; }
.form-actions:has(.close-reason option[value="split"]:checked) .close-into { display: inline-block; }
/* On a phone the Markdown hint takes its own line, so the reason, Close and
   Comment stay together on the next one instead of Comment wrapping alone. */
@media (max-width: 480px) {
  .comment-form .form-actions > .muted.small { flex-basis: 100%; }
  .comment-form .form-actions > .spacer { display: none; }
  .comment-form .form-actions > :last-child { margin-left: auto; }
  /* The reason select, Close and Comment must fit 332 px with room to
     spare: a tighter gap and a narrower select. */
  .comment-form .form-actions { gap: 6px; }
  .comment-form .form-actions .close-reason { padding-inline: 8px 24px; max-width: 84px; }
  /* Words carry the buttons here; their icons give back the width a 360 px
     row needs for "Close issue", and the buttons keep their full height. */
  .comment-form .form-actions .btn .ico { display: none; }
}
.connect-more .connect-path { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
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
/* Make it yours: what is copied and what is not, read before saying yes. */
.kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 14px; margin: 0; }
.kv dt { color: var(--muted-fg); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
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
.tree-total { margin: 6px 2px 0; text-align: right; }
.tok { white-space: nowrap; }

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
/* A list's six words fit a phone without pushing the page sideways: a
   little less padding there, and a scroll inside the bar as the last resort. */
.filters .seg { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
@media (max-width: 420px) { .filters .seg > a { padding: 0 8px; } }

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

/* A fork's relationship to what it follows: one sentence, one action. */
.following { margin-top: 12px; }
.following-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.following-eyebrow { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted-fg); }
.following-eyebrow a { color: var(--fg); text-transform: none; letter-spacing: 0; font-family: var(--font); font-size: 13px; font-weight: 600; }
.following-sentence { margin: 8px 0 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; text-wrap: balance; }
.following-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.following-foot { margin: 8px 0 0; }

/* The audit: one app's policy as a table, an answer per cell. */
.audit-sum { margin: 0 0 14px; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; text-wrap: balance; }
.audit-app { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--fg); margin: 0; font-size: 14px; }
.audit-app .ico { color: var(--faint); }
.audit-trail { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
.audit-trail code { font-size: 11px; }
.audit th[scope="rowgroup"] { vertical-align: top; font-family: var(--mono); font-weight: 600; }
.audit th[scope="row"] { font-weight: 400; color: var(--muted-fg); }
.audit th[scope="rowgroup"], .audit th[scope="row"] { width: 1%; white-space: nowrap; padding-right: 24px; }
.audit thead th:nth-child(n + 3), .audit td { text-align: center; }
.audit-answer {
  display: inline-block; min-width: 3.5ch; padding: 1px 6px; border-radius: 999px;
  font-family: var(--mono); font-size: 11px; line-height: 18px;
}
.audit-answer[data-answer="yes"] { background: color-mix(in srgb, var(--attn) 18%, transparent); color: var(--attn); }
.audit-answer[data-answer="own"] { background: var(--muted); color: var(--fg); }
.audit-answer[data-answer="no"] { color: var(--faint); }
.audit-problems { margin: 0; padding-left: 18px; font-size: 13px; }
.audit-wide { flex-basis: 100%; }
.audit-said { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.audit-alarm { color: var(--danger); }
.wall-cells { margin: 8px 0 0; padding-left: 18px; font-family: var(--mono); font-size: 12px; }
.grants th, .grants td { padding: 8px 12px; border-top: 1px solid var(--border); }
.grants thead th { border-top: 0; font-weight: 600; }
.grants th[scope="col"], .grants td { text-align: center; }
.grants th[scope="row"] { text-align: left; font-weight: 500; white-space: nowrap; }
.grants input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); }
.grants-foot { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-top: 1px solid var(--border); }
/* A subscription's headroom for people: a small number beside its windows. */
.headroom { display: flex; align-items: center; gap: 6px; }
.headroom .input { width: 5em; }
/* A spawned forge's first steps (#600): three rows, the next one leading. */
.next-crew { margin: 0 0 12px 1.1em; }
.next-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
.next-step { display: grid; grid-template-columns: 1.4em minmax(0, 1fr); gap: 8px; align-items: start; }
.next-step-mark { color: var(--faint); padding-top: 2px; }
.next-step[data-done="yes"] .next-step-mark { color: var(--success, var(--accent)); }
.next-step[data-done="yes"] .next-step-title { color: var(--muted-fg); text-decoration: line-through; }
.next-step[data-primary] .next-step-title { font-weight: 600; }
.next-step-main { display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 36rem; }
.next-step-apps { display: flex; flex-wrap: wrap; gap: 6px; }
/* The everyday-account ask on the home: a form's width, not the page's. */
.everyday-ask { max-width: 34rem; margin-bottom: 16px; }
/* On a phone an account's controls go under its name, not over it. */
@media (max-width: 640px) {
  .row:has(.headroom) { flex-wrap: wrap; }
  .row:has(.headroom) .row-trail { flex-basis: 100%; flex-wrap: wrap; }
}
.backups-now { margin-top: 12px; }
/* The fleet graph: a selection's spend and runs, hour by hour and day by day.
   Series colours are Okabe–Ito (told apart with common colour-vision
   deficiencies); the eighth, the folded "others", is grey. */
.fleet-pick { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 16px; }
.fleet-pick input { flex: 1 1 24em; min-width: 0; font-family: var(--mono); font-size: 13px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); }
.fleet-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 12px; padding: 0; list-style: none; font-size: 13px; }
.fleet-legend li { display: inline-flex; align-items: center; gap: 6px; }
.fleet-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: currentColor; vertical-align: middle; flex: none; }
.fleet-windows { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 16px; margin: 0 0 16px; }
.fleet-window { margin: 0; }
.fleet-window figcaption { font-size: 13px; font-weight: 600; margin: 0 0 4px; display: flex; gap: 8px; align-items: baseline; }
.fleet-svg { display: block; width: 100%; height: auto; aspect-ratio: 600 / 230; }
.fleet-grid line { stroke: var(--border); stroke-width: 1; }
.fleet-ticks text { fill: var(--muted-fg); font-size: 10px; text-anchor: end; font-family: var(--mono); }
.fleet-axis text { fill: var(--muted-fg); font-size: 10px; text-anchor: middle; font-family: var(--mono); }
.fleet-panel-name text { fill: var(--faint); font-size: 10px; }
.fleet-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.fleet-table th[scope="row"] { font-weight: 500; white-space: nowrap; text-align: left; }
.fleet-assume { margin-top: 8px; }
.fg-s0 { fill: #0072b2; color: #0072b2; }
.fg-s1 { fill: #e69f00; color: #e69f00; }
.fg-s2 { fill: #009e73; color: #009e73; }
.fg-s3 { fill: #cc79a7; color: #cc79a7; }
.fg-s4 { fill: #56b4e9; color: #56b4e9; }
.fg-s5 { fill: #d55e00; color: #d55e00; }
.fg-s6 { fill: #c9b800; color: #c9b800; }
.fg-s7 { fill: #8a8a8a; color: #8a8a8a; }
@media print { .fleet-pick { display: none; } }
.backups-error { display: flex; align-items: center; gap: 8px; color: var(--danger); }
.backups-restore { margin: 8px 0 0; padding: 8px 10px; font-size: 12px; white-space: pre-wrap; word-break: break-all; background: var(--muted); border-radius: var(--radius); }
/* The records a domain waits on: type, name, value — as a zone file reads. */
.domain-records { margin: 6px 0 2px; padding: 8px 10px; font-size: 12px; line-height: 1.6; white-space: pre; overflow-x: auto; scrollbar-width: thin; background: var(--muted); border-radius: var(--radius); }
.policy-line {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 12px 0 0; font-size: 13px; color: var(--muted-fg);
}
.policy-line .ico { color: var(--faint); flex: none; }
.policy-line b { color: var(--fg); font-weight: 600; }
.policy-line[data-tone="mismatch"] .ico { color: var(--danger); }
.policy-line[data-tone="ok"] .ico { color: var(--success); }
.audit-h2 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; margin: 22px 0 10px; }
.audit-cells { margin-top: 6px; font-family: var(--mono); font-size: 12px; }
.audit-cells li[data-way="wider"] { color: var(--attn); }
.audit-cells li[data-way="narrower"] { color: var(--success); }
.audit-change .row-main { min-width: 0; }
.wall-cells li + li { margin-top: 3px; }
form.inline { display: inline; margin-left: auto; }
.audit-problems li + li { margin-top: 4px; }
.audit-unread { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; }

/* The family tree: nesting is indentation and a rule, never a scrollbar. */
.lineage-children {
  list-style: none; margin: 0 0 0 22px; padding: 0;
  border-left: 1px solid var(--border);
}
.lineage-children .row { padding-left: 12px; }
.lineage-here {
  margin-left: 6px; font-family: var(--mono); font-size: 11px; font-weight: 500;
  letter-spacing: 0.04em; color: var(--accent);
}
.lineage .row[aria-current="page"] { background: var(--muted); }
@media (max-width: 719px) { .lineage-children { margin-left: 12px; } }

.hero { max-width: 620px; margin: 12dvh auto 0; text-align: center; }
.hero h1 { font-size: clamp(30px, 7vw, 44px); letter-spacing: -0.04em; line-height: 1.05; }
.hero p { margin: 12px 0 24px; font-size: 16px; color: var(--muted-fg); text-wrap: pretty; }
.hero-terminal { display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline; gap: 6px 14px; margin: -8px 0 28px; font-size: 14px; }
.hero-terminal .mono { font-size: 15px; }
.terminal-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
.hero .bar { justify-content: center; }

/* The studio's front door: the public apps, live first, as pictures. */
.app-shelf {
  display: grid; gap: 16px; max-width: 1040px; margin-inline: auto;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
}
.app-tile {
  display: block; border: 1px solid var(--border); border-radius: var(--radius);
  overflow: hidden; background: var(--card); color: inherit; text-decoration: none;
}
.app-tile:hover { border-color: var(--accent); }
.app-tile-look { display: block; width: 100%; height: auto; background: var(--muted); }
.app-tile-body { display: grid; gap: 6px; padding: 10px 12px; }
.app-tile-name { font-weight: 600; font-size: 14px; }
.app-tile-desc { color: var(--muted-fg); font-size: 12.5px; }

/* Explore (#607): a row is a name, a line, its numbers, and one verb. */
.explore-row { gap: 12px; }
.explore-main { display: grid; gap: 2px; min-width: 0; flex: 1; }
.explore-name { font-weight: 600; }
.explore-line .input { flex: 1; min-width: 0; }

/* The featured repository: its picture and its crew at work, side by side
   on a desk, stacked on a phone. */
.front-featured {
  display: grid; gap: 0; max-width: 1040px; margin-inline: auto;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  border: 1px solid var(--border); border-radius: var(--radius);
  overflow: hidden; background: var(--card);
}
.front-featured-look img { display: block; width: 100%; height: auto; background: var(--muted); }
.front-featured-body { display: grid; align-content: center; gap: 8px; padding: 20px 24px; min-width: 0; }
.front-featured-body > * { min-width: 0; }
.front-featured-body h2 { font-size: 20px; letter-spacing: -0.02em; }
.front-featured-body h2 a { color: inherit; text-decoration: none; }
.front-featured-body p { color: var(--muted-fg); text-wrap: pretty; }
.front-featured:not(:has(.front-featured-look)) { grid-template-columns: 1fr; }
.front-crew { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.front-live {
  width: 8px; height: 8px; border-radius: 50%; background: var(--success);
  animation: run-pulse 1.6s ease-in-out infinite;
}
.front-issues { display: grid; gap: 4px; font-size: 13.5px; list-style: none; padding: 0; margin: 0; }
.front-issues li { min-width: 0; }
.front-issues a { color: inherit; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.front-more { text-align: center; }
.front-admin { max-width: 1040px; margin-inline: auto; }
.front-pick { gap: 8px; }
.front-pick form.inline { margin-left: 0; }
.front-pin-any { padding: 12px 16px; flex-wrap: nowrap; }
.front-pin-any .input { flex: 1; min-width: 0; }
.front-controls .small { padding: 0 16px 14px; }
@media (max-width: 520px) {
  /* Two to a row on a phone: a few live apps in one screen, not a scroll. */
  .app-shelf { gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .app-tile-body { padding: 8px 10px; }
}
@media (max-width: 720px) {
  .front-featured { grid-template-columns: 1fr; }
  .front-featured-body { padding: 16px; }
}

/* Every page grid, in one rule: a grid item's automatic minimum size is its
   *content*, so a column with a long unbreakable line pushes the page wider
   than the phone rather than letting its own ellipsis do the work. A zero
   min-width is what makes truncation inside a grid actually truncate. */
.dash > *, .split > *, .repo-layout > * { min-width: 0; }

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
.tok-plain { color: inherit; }
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
.blob-view .seg { font-size: 12px; }

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
.prose th { background: var(--muted); font-weight: 600; }
.prose .ta-c { text-align: center; }
.prose .ta-r { text-align: right; }
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
.diff-stub p { margin: 0 0 10px; }
.diff-stub .diff-stat { display: inline-flex; }
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

/* A settled thread is one line plus a disclosure: the point of resolving is
   to get an answered question out of the way of the unanswered ones. */
.rc-resolved { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rc-resolved-line {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; color: var(--muted-fg);
}
.rc-resolved-line .ico { width: 14px; height: 14px; color: var(--success); }
.rc-hidden { flex-basis: 100%; }
.rc-hidden > summary {
  cursor: pointer; font-size: 13px; color: var(--muted-fg);
  padding: 2px 0; list-style: none;
}
.rc-hidden > summary::-webkit-details-marker { display: none; }
.rc-hidden > summary::before { content: "▸ "; }
.rc-hidden[open] > summary::before { content: "▾ "; }
.rc-hidden > summary:hover { color: var(--fg); }
.rc-hidden[open] { margin-top: 6px; }
.rc-resolve { display: inline-flex; margin-left: auto; }

/* ---- review verdicts ---- */
/* A verdict passed before the latest push is history, not a position: it
   keeps its words and loses its colour. */
.verdict-stale { color: var(--muted-fg); background: none; }
.verdict-stale .ico { width: 12px; height: 12px; }
.review-body {
  flex-basis: 100%; margin-top: 4px; padding: 8px 12px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 13.5px; color: var(--fg);
}
.review-body p:first-child { margin-top: 0; }
.review-body p:last-child { margin-bottom: 0; }
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
.files-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.files-head h2 { margin-bottom: 0; }

/* ---- apps, runs, and the crew ---- */
/* The strip a repo home wears when it runs: state, commit, URL, previews,
   and the way to the App page — one line, in the repo header's own voice. */
.app-strip {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-top: 12px; padding: 8px 12px; font-size: 13px;
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
}
.app-strip > .ico { color: var(--muted-fg); flex: none; }
.app-strip .app-url {
  min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--mono); font-size: 12.5px;
}
.app-strip .spacer { flex: 1; }
/* One environment: name and state in the head, the facts and the reason it
   failed in the body. A card rather than a row so a deploy error has a whole
   line to be read on. The facts and the error read the same wherever they
   are shown — a pull's preview, the studio head — so they are not scoped to
   the card. */
.env-card .card-head { gap: 10px; }
.env-facts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--muted-fg); }
.env-error { color: var(--danger); font-size: 13px; margin-top: 6px; overflow-wrap: anywhere; text-wrap: pretty; }
/* The look: a phone beside a desktop, each in a hairline frame. The phone
   keeps a phone's narrowness; the desktop takes what is left, never more
   than its own size. A thumbnail shows the top of the phone picture; the
   studio head shows production small. */
.look-card .card-head { gap: 10px; flex-wrap: wrap; }
.look-card .look-of { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.look-pair { display: flex; gap: 14px; align-items: flex-start; }
.look { display: block; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--muted); }
.look img { display: block; width: 100%; height: auto; }
.look-phone { flex: 0 0 200px; }
.look-desktop { flex: 1 1 320px; min-width: 0; max-width: 1280px; }
@media (max-width: 640px) {
  .look-pair { flex-direction: column; }
  .look-phone { flex-basis: auto; width: 200px; }
}
.look-thumb { display: block; flex: none; width: 30px; height: 40px; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; background: var(--muted); }
.look-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
.look-now { display: block; flex: none; width: 168px; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--muted); }
.look-now img { display: block; width: 100%; height: auto; }
/* The checks line inside the merge box, in the reviews chip's voice. */
.checks-line {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-top: 6px; font-size: 13px; color: var(--muted-fg);
}
.checks-line .ico { width: 14px; height: 14px; }
.checks-line .ok { display: inline-flex; align-items: center; gap: 4px; color: var(--success); }
.checks-line .bad { display: inline-flex; align-items: center; gap: 4px; color: var(--danger); }
.checks-line .now { display: inline-flex; align-items: center; gap: 4px; color: var(--attn); }
/* A run, live: a transcript with a speaker column, bounded so the page
   head stays reachable, and a composer that sits under it. */
.run-live { position: relative; margin-top: 12px; }
.run-log {
  margin: 0; padding: 10px 14px 8px; max-height: calc(100dvh - 300px); min-height: 12em; overflow: auto;
  background: var(--muted); border: 1px solid var(--border); border-radius: var(--radius);
  font-size: 13.5px; line-height: 1.5; overflow-wrap: anywhere; tab-size: 4;
}
.run-live:has(.run-steer) .run-log { border-radius: var(--radius) var(--radius) 0 0; }
.run-log .ln { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 10px; padding: 2px 0; }
.run-log .who { color: var(--faint); font-size: 12px; font-weight: 600; padding-top: 2px; user-select: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-log .txt { white-space: pre-wrap; }
.run-log .ln-say .who { color: var(--fg); }
.run-log .ln-say + .ln-say > .who, .run-log .ln-say + .ln-tool > .who, .run-log .ln-tool + .ln-tool > .who,
.run-log .ln-tool + .ln-say > .who, .run-log .ln-forge + .ln-forge > .who, .run-log .ln-say + .ln-pulse > .who,
.run-log .ln-tool + .ln-pulse > .who { visibility: hidden; }
.run-log .ln-tool .txt { font-family: var(--mono); font-size: 12px; color: var(--faint); }
.run-log .ln-tool b { color: var(--fg); font-weight: 600; }
.run-log .ln-forge .txt { color: var(--faint); font-style: italic; }
.run-log .ln-you { margin: 6px 0; }
.run-log .ln-you .who { color: var(--accent); }
.run-log .ln-you .txt { background: color-mix(in srgb, var(--accent) 10%, transparent); border-left: 2px solid var(--accent); padding: 4px 10px; border-radius: 0 var(--radius) var(--radius) 0; }
.run-log .ln-pulse .txt { padding-top: 6px; }
.run-log .ln-pulse i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--faint); margin-right: 4px; animation: run-pulse 1.2s infinite ease-in-out; }
.run-log .ln-pulse i:nth-child(2) { animation-delay: .2s; }
.run-log .ln-pulse i:nth-child(3) { animation-delay: .4s; }
@keyframes run-pulse { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
.run-jump {
  position: sticky; bottom: 6px; float: right; margin-top: 6px; padding: 4px 10px; font: inherit; font-size: 12px;
  color: var(--bg); background: var(--fg); border: 0; border-radius: 999px; cursor: pointer; box-shadow: var(--shadow, 0 2px 8px rgba(0,0,0,.15));
}
.run-steer {
  position: sticky; bottom: 0; display: grid; gap: 6px; padding: 10px 12px; background: var(--bg);
  border: 1px solid var(--border); border-top: 0; border-radius: 0 0 var(--radius) var(--radius);
}
.run-steer textarea { min-height: 38px; max-height: 160px; resize: none; }
.run-steer .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.run-steer .bar .muted { flex: 1 1 200px; }
.run-summary { margin: 10px 0 0; text-wrap: pretty; }
.run-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.run-actions form { display: inline-flex; }
/* A tail beside a running row (studio/app.ts): the same log, a peek at it
   — fixed height so nothing around it shifts as lines arrive, and it
   scrolls itself rather than the page. */
.log-tail-row { padding: 0 14px 10px; }
.run-log.log-tail { max-height: 8.5em; min-height: 0; margin: 6px 0 0; font-size: 12.5px; }
.table .truncate { max-width: 34ch; display: inline-block; vertical-align: bottom; }
.agent-brief { white-space: pre-wrap; font-size: 13px; color: var(--muted-fg); max-height: 6.5em; overflow: hidden; }

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
.code-main { min-width: 0; }
.code-main[aria-busy="true"] { opacity: .55; transition: opacity 120ms var(--ease); }
/* The divider is nothing until a script can drag it, and nothing on one
   column either. */
.code-split { display: none; }

.explorer-panel { min-width: 0; }
.explorer-panel:not([open]) > .explorer-toggle { border-radius: var(--radius-sm); }
.explorer-toggle {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--card); font-weight: 550; list-style: none;
}
.explorer-toggle::-webkit-details-marker { display: none; }
.explorer-toggle .ico { color: var(--faint); }
.explorer-toggle .ex-ref { color: var(--muted-fg); font-size: 12px; }
.explorer-panel[open] > .explorer-toggle { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }

.explorer {
  border: 1px solid var(--border); border-top: none;
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  background: var(--card);
  max-height: 45dvh; overflow: auto; overscroll-behavior: contain;
  scrollbar-width: thin;
  padding: 4px 0 8px;
}
.ex-head { display: flex; gap: 6px; padding: 6px 8px; flex-wrap: wrap; }
.ex-head .btn { flex: 1; justify-content: flex-start; }
.ex-find kbd { margin-left: auto; }

.ex-list { margin: 0; padding: 0; list-style: none; }
.ex-list .ex-list { padding-left: 12px; border-left: 1px solid var(--border); margin-left: 10px; }
.ex-file, .ex-dir > summary, .ex-more {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 10px; min-height: 26px;
  font-size: 13px; color: var(--muted-fg);
  overflow: hidden; cursor: pointer; list-style: none;
}
.ex-dir > summary::-webkit-details-marker { display: none; }
@media (pointer: coarse) { .ex-file, .ex-dir > summary, .ex-more { min-height: 44px; } }
.ex-file .ico, .ex-more .ico { color: var(--faint); flex: none; width: 14px; height: 14px; }
.ex-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-twist { display: inline-flex; flex: none; color: var(--faint); transition: transform 120ms var(--ease); }
.ex-twist .ico { width: 14px; height: 14px; }
.ex-dir[open] > summary > .ex-twist { transform: rotate(90deg); }
.ex-dir > summary { font-weight: 500; color: var(--fg); }
.ex-file:hover, .ex-dir > summary:hover, .ex-more:hover { background: var(--muted); color: var(--fg); }
.ex-file[aria-current="page"] {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--fg); font-weight: 550;
}
.ex-file:focus-visible { outline-offset: -2px; }
.ex-dir > summary[data-current] { color: var(--accent); }
.ex-more { color: var(--accent); font-size: 12.5px; }
.ex-empty { display: block; padding: 3px 10px 3px 16px; font-size: 12.5px; color: var(--faint); }

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
  :root.js .code-split {
    display: block; position: sticky; align-self: stretch;
    top: calc(var(--topbar-h) + 12px);
    max-height: calc(100dvh - var(--topbar-h) - 32px);
    width: 12px; cursor: col-resize; touch-action: none;
    border-radius: var(--radius-sm);
  }
  .code-split::before {
    content: ""; position: absolute; inset: 0 -4px;
  }
  .code-split::after {
    content: ""; position: absolute; top: 0; bottom: 0; left: 50%;
    width: 1px; margin-left: -0.5px; background: var(--border);
    transition: background-color 120ms var(--ease), width 120ms var(--ease), margin-left 120ms var(--ease);
  }
  .code-split:hover::after, .code-split:focus-visible::after, .code-layout[data-dragging] .code-split::after {
    width: 3px; margin-left: -1.5px; background: var(--accent);
  }
  .code-split:focus-visible { outline-offset: 0; }
  /* While a drag is on, nothing beneath the pointer may select or steal
     the cursor. */
  .code-layout[data-dragging] { cursor: col-resize; user-select: none; -webkit-user-select: none; }
  .code-layout[data-dragging] .code-main, .code-layout[data-dragging] .explorer-panel { pointer-events: none; }
}
@supports selector(::details-content) {
  @media (min-width: 900px) {
    .explorer-panel > .explorer-toggle { display: none; }
  }
}
@media (min-width: 900px) and (pointer: coarse) {
  /* A finger needs 44px: the lane keeps its width and the hit area grows
     under it, into the padding on either side. */
  .code-split::before { inset: 0 -16px; }
}
@media (min-width: 1200px) {
  .code-layout { grid-template-columns: minmax(0, var(--ex-w, 300px)) auto minmax(0, 1fr); }
}

/* ---- the finder ---- */
.finder { width: min(720px, calc(100vw - 24px)); }
@media (max-width: 719px) { .finder { width: 100%; max-width: 100%; } }
.finder .palette-item .cat {
  font-family: var(--mono); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%;
}
.finder .palette-item .grow { font-family: var(--mono); font-size: 12.5px; }
.finder-note { color: var(--faint); font-variant-numeric: tabular-nums; }

/* ---- the editor ---- */
.editor-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 12px 0 0; padding: 8px 10px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}
.editor-head .editor-path { flex: 1 1 16rem; min-width: 0; }
.editor-tab[aria-selected="true"] { background: var(--muted); color: var(--fg); font-weight: 550; }

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
  font-family: var(--mono); font-size: 12.5px; line-height: 1.55;
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
.editor-stack {
  position: relative; display: grid; flex: 1; min-width: 0; min-height: 0;
}
.editor-mirror,
textarea.editor {
  grid-area: 1 / 1;
  margin: 0; border: none; background: none;
  padding: 10px 12px; min-height: 14rem;
  font-family: var(--mono); font-size: 12.5px; line-height: 1.55;
  tab-size: 2; white-space: pre;
  overflow: auto;
}
.editor-wrap.mirrored .editor-mirror,
.editor-wrap.mirrored textarea.editor { min-height: 0; }
textarea.editor { resize: vertical; field-sizing: content; }
textarea.editor:focus { outline: none; }
.editor-mirror {
  overflow: hidden; pointer-events: none; user-select: none;
  color: var(--fg);
}
/* Only when the mirror is live does the textarea's own text step aside — with
   no script (or no bundle) the plain textarea is what you see. */
.editor-wrap:not(.mirrored) .editor-mirror { display: none; }
.editor-wrap.mirrored textarea.editor {
  color: transparent;
  caret-color: var(--fg);
  -webkit-text-fill-color: transparent;
}
.editor-wrap.mirrored textarea.editor::selection {
  background: color-mix(in srgb, var(--accent) 30%, transparent);
}
.editor-mirror .ml {
  display: block; min-height: 1.55em; min-width: 100%; width: max-content;
}
.editor-mirror .ml.cur {
  background: color-mix(in srgb, var(--muted) 75%, transparent);
}
.editor-wrap:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.editor-preview {
  border: 1px solid var(--border); border-top: none;
  border-radius: 0 0 var(--radius) var(--radius);
  background: var(--card); min-height: 12rem;
}
.editor-commit { margin-top: 12px; }
.editor-hint { margin: 6px 2px 0; font-size: 12.5px; color: var(--faint); }
.editor-hint kbd { margin: 0 2px; }
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
.live-toggle {
  display: flex; align-items: center; gap: 6px;
  margin: 10px 0 0; color: var(--muted-fg);
}
.live-toggle .ico { color: var(--faint); flex: none; }
.live-toggle a { color: var(--accent); }
.no-hits {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; margin: 0;
  border: 1px dashed var(--border); border-radius: var(--radius);
}
.no-hits .ico { color: var(--faint); flex: none; }

}
/* What needs you, pinned on the home: the bulk step's select as wide as
   its words, not the column. */
.needs-you #asks-bulk select { width: auto; }
`;
