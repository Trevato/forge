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
 */

/** A part as written, without the newlines the template literal adds. */
const part = (css: string): string => css.trim();

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

/** The word itself where a row's meta line still carries one, and the
 * shelf row's meta line (`shelf.ts`). */
const rows = part(/* css */ `
.studio-word { font-family: var(--mono); font-size: 11.5px; opacity: .8; white-space: nowrap; }
.shelf-meta { display: flex; gap: 0 4px; min-width: 0; }
.shelf-desc { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shelf-facts { flex: 0 0 auto; max-width: 100%; }
.row-meta .studio-word { font-family: inherit; font-size: inherit; opacity: 1; font-weight: 560; }
`);

/** The row of controls beside a list row: a stop, a change's buttons. */
const rowActions = part(/* css */ `
.studio-ask-actions { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
`);

/** The phone: one document, narrower. Each rule belongs to a component above
 * and only ever applies at 600px and under, so nothing changes on a desktop. */
const phone = part(/* css */ `
@media (max-width: 600px) {
  .studio-head { flex-wrap: wrap; }
  .feed .card-head { row-gap: 2px; }
  .feed .card-head .fcard-app { flex: 1 1 100%; }
  .studio-head h1 { flex: 1 1 100%; flex-wrap: wrap; overflow-wrap: anywhere; }
  .studio-head .env-facts { flex: 1 1 100%; min-width: 0; overflow-wrap: anywhere; }
  .studio-head form, .studio-head form .btn { flex: 1 1 auto; }
  .studio-tell .bar { flex-wrap: wrap; }
  .studio-tell .bar .btn, .studio-ask-actions .btn { min-height: 44px; }
  .feed .bar .btn, .fcard-form .btn { min-height: 44px; }
  .studio-ask-actions { display: flex; flex-direction: column; align-items: stretch; white-space: normal; width: 100%; }
  .studio-word { white-space: normal; }
  .shelf-meta { flex-wrap: wrap; }
  .shelf-desc { flex: 1 1 100%; }
  .studio-tell textarea, .studio-tell .input { font-size: 16px; }
}
`);

import { feedCss } from "./feed_style.ts";

export const studioCss = `@layer components {\n${[
  tellBox,
  appHead,
  justChanged,
  wordBadges,
  rows,
  rowActions,
  part(feedCss),
  phone,
].join("\n\n")}\n}`;
