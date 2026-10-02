/**
 * The studio's slice of the served stylesheet (`web/style.ts` assembles it
 * in, beside `style/*`). These rules are the studio's design, identical for
 * every visitor and every request, so they belong in the file the browser
 * caches — not in a `<style>` block on every studio page.
 *
 * Each part is named for the concept whose markup it styles. They land in the
 * `components` layer, last, which is where an inline block's rules used to
 * win from: nothing else in the sheet styles a `.studio-*` selector, and the
 * few rules that reach a shared class (`.badge`, `.row-lead`, `.env-facts`)
 * set properties those components do not.
 *
 * `shell` and `rail` hold rules nothing in this directory draws any more,
 * and `rows` all but two of them. They are kept exactly as they were because
 * this is a pure move — deleting a rule changes what is served, and that is
 * its own issue.
 */

/** A part as written, without the newlines the template literal adds. */
const part = (css: string): string => css.trim();

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

/** A card the live client just swapped in place (`live.ts`): a background
 * flash, never a resize, so the page never shifts under a reader. */
const justChanged = part(/* css */ `
#app-head.studio-just-changed, #app-previews.studio-just-changed { animation: studio-flash 1.1s var(--ease); border-radius: var(--radius); }
@keyframes studio-flash { 0% { background-color: color-mix(in srgb, var(--accent) 14%, transparent); } 100% { background-color: transparent; } }
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

/** The row of controls beside a list row: a stop, a change's buttons. */
const rowActions = part(/* css */ `
.studio-ask-actions { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
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

import { feedCss } from "./feed_style.ts";

export const studioCss = `@layer components {\n${[
  shell,
  tellBox,
  appHead,
  justChanged,
  wordBadges,
  rows,
  rowActions,
  rail,
  part(feedCss),
].join("\n\n")}\n}`;
