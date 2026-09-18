/**
 * The studio's page stylesheet: the one `styleCss` block every studio page
 * hands `page()`, assembled from named parts the way `web/style.ts` assembles
 * the served sheet from `style/*`. Each part is named for the concept whose
 * markup it styles, and they are joined in the order they were served when
 * this was one block at the bottom of `pages/studio.ts`, so the sheet is
 * byte-for-byte the string it has always been. `bulkCss` is not written here
 * at all: it is derived from the same table the bulk route enforces
 * (`asks.ts`).
 *
 * `shell` and `rail` hold rules nothing in this directory draws any more,
 * and `rows` all but two of them. They are kept exactly as they were because
 * this is a pure move — deleting a rule changes what is served, and that is
 * its own issue.
 */

import { bulkCss } from "./asks.ts";

/** A part as written: the newline that opens the template belongs to the
 * sheet, the one that closes it does not. */
const part = (css: string): string => css.slice(0, -1);

/** The first studio's own two-column shell, and the preview box it drew. */
const shell = part(/* css */ `
.studio { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 22px; margin-top: 16px; }
@media (max-width: 860px) { .studio { grid-template-columns: 1fr; } }
.studio-main { display: grid; gap: 18px; }
.studio-preview { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--muted); }
.studio-preview-head { display: flex; align-items: center; gap: 12px; }
.studio-live { font-family: var(--mono); font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
.studio-live[data-state="running"] { color: var(--merged); border-color: var(--merged); }
.studio-live[data-state="failed"] { color: var(--danger, #c33); }
`);

/** The box a person tells the crew from (`app.ts`). */
const tellBox = part(/* css */ `
.studio-tell textarea { min-height: 72px; resize: vertical; }
.studio-tell .bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
`);

/** The app's head card: what production is doing (`previews.ts`). */
const appHead = part(/* css */ `
.studio-head h1 { display: flex; align-items: center; gap: 10px; }
/* The facts under the title take the whole line; the two buttons that act
   on production sit with the rest, each in its own POST form. */
.studio-head .env-facts { margin-top: 2px; }
.studio-head form { display: inline-flex; }
`);

/** One of the five words, as a badge (`words.ts`). */
const wordBadges = part(/* css */ `
.badge[data-variant="accent"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 34%, transparent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.badge[data-word="working"] svg { animation: spin 1.1s linear infinite; }
`);

/** The first studio's word rows, and the word itself where a row's meta
 * line still carries one (`home.ts`). */
const rows = part(/* css */ `
.studio-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.studio-list li { display: grid; grid-template-columns: 18px 84px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; }
.studio-list li svg { vertical-align: -3px; }
.studio-who { font-weight: 600; }
.studio-word { font-family: var(--mono); font-size: 11.5px; opacity: .8; white-space: nowrap; }
.row-meta .studio-word { font-family: inherit; font-size: inherit; opacity: 1; font-weight: 560; }
.studio-list li[data-word="working"] .studio-word { color: var(--accent); opacity: 1; }
.studio-list li[data-word="look"] .studio-word { color: var(--merged); opacity: 1; }
.studio-list li[data-word="stopped"] .studio-word { color: var(--danger, #c33); opacity: 1; }
`);

/** The asks panel: a row's controls, the picker, the bulk bar (`asks.ts`). */
const asks = part(/* css */ `
.studio-ask-actions { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.studio-lean { margin-left: 2px; }
.studio-asks .row-lead { gap: 8px; }
.studio-ask-pick { accent-color: var(--accent); margin: 0; width: 13px; height: 13px; opacity: .6; }
.studio-ask-pick:checked, .studio-ask-pick:focus-visible, .row:hover .studio-ask-pick { opacity: 1; }
.studio-bulk { display: none; align-items: center; gap: 8px; padding: 6px 14px; border-bottom: 1px solid var(--border); font-size: 12.5px; background: color-mix(in srgb, var(--accent) 7%, var(--card)); }
.studio-asks:has([name="ask"]:checked) .studio-bulk { display: flex; }
.studio-bulk-count { font-weight: 550; font-variant-numeric: tabular-nums; }
.studio-bulk-none { display: none; }
.studio-asks li[data-busy] { opacity: .6; }
.studio-asks li[data-busy] .studio-ask-actions { visibility: hidden; }
.studio-asks li[data-busy] .row-lead svg { display: none; }
.studio-asks li[data-busy] .row-lead::after { content: ""; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
.studio-ask-note { color: var(--danger, #c33); }
`);

/** The first studio's rail, and the crew list it held. */
const rail = part(/* css */ `
.studio-rail { display: grid; gap: 18px; align-content: start; }
.studio-rail h3 { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; opacity: .7; margin: 0 0 6px; font-weight: 600; }
.studio-crew { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; font-size: 13.5px; }
.studio-crew li { display: grid; grid-template-columns: 74px 1fr; gap: 8px; }
.studio-crew li b { font-weight: 600; }
.studio-crew li span { opacity: .85; }
`);

export const studioCss = `${[
  shell,
  tellBox,
  appHead,
  wordBadges,
  rows,
  asks,
  `\n${bulkCss}`,
  rail,
].join("")}\n`;
