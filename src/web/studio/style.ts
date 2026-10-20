/**
 * The studio's slice of the served stylesheet (`web/style.ts` assembles it
 * in, beside `style/*`). These rules are the studio's design, identical for
 * every visitor and every request, so they belong in the file the browser
 * caches — not in a `<style>` block on every studio page.
 *
 * Each part is named for the concept whose markup it styles. They land in the
 * `components` layer, last, which is where an inline block's rules used to
 * win from: nothing else in the sheet styles a `.studio-*` selector, and the
 * few rules that reach a shared class (`.badge`, `.card-head`, `.bar`) set
 * properties those components do not. The tell box, the app head, the word
 * and the shelf rows are §5's own card, page head, bar and row, unstyled here.
 */

/** A part as written, without the newlines the template literal adds. */
const part = (css: string): string => css.trim();

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

/** The phone: one document, narrower. Each rule belongs to a component above
 * and only ever applies at 600px and under, so nothing changes on a desktop. */
const phone = part(/* css */ `
@media (max-width: 600px) {
  .feed .card-head { row-gap: 2px; }
  .feed .bar .btn, .fcard-form .btn { min-height: 44px; }
}
`);

import { feedCss } from "./feed_style.ts";

export const studioCss = `@layer components {\n${[
  justChanged,
  wordBadges,
  part(feedCss),
  phone,
].join("\n\n")}\n}`;
