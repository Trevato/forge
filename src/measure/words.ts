/**
 * Counting the words of a page, one way: from its HTML, whether that HTML was
 * served or read back from a browser's DOM (`scripts/measure-page.ts`). A
 * word is a run of non-space characters in the text of `<main>`, or of one
 * element of it; tags, `<script>`, `<style>` and comments are not text, and
 * the five entities the page writer produces count as spaces or their
 * character.
 */

/** The text of `html` with markup removed. */
export function textOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The words in `html`'s text. */
export const countWords = (html: string): number => textOf(html).split(/\s+/).filter(Boolean).length;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The inside of the element whose start tag is at `open` (matched by `tag`), to its balancing end tag. */
function inside(html: string, open: RegExpExecArray, tag: string): string {
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tags.lastIndex = open.index + open[0].length;
  let depth = 1;
  let end = html.length;
  for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) {
      end = m.index;
      break;
    }
  }
  return html.slice(open.index + open[0].length, end);
}

/**
 * The HTML inside the element with this `id`; failing that, inside the card
 * or section whose `<h2>` reads as the id with its hyphens as spaces (a page
 * from before its sections had ids). `undefined` when neither is there.
 */
export function sectionHtml(html: string, id: string): string | undefined {
  const byId = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${escapeRe(id)}"[^>]*>`, "i").exec(html);
  if (byId !== null) return inside(html, byId, byId[1]!.toLowerCase());
  const h2 = new RegExp(`<h2[^>]*>\\s*${escapeRe(id.replace(/-/g, " "))}\\s*</h2>`, "i").exec(html);
  if (h2 === null) return undefined;
  const starts = [...html.slice(0, h2.index).matchAll(/<(?:div\s+class="card[ "]|section\b)[^>]*>/gi)];
  const last = starts[starts.length - 1];
  if (last === undefined) return undefined;
  const open = /<(div|section)\b[^>]*>/i.exec(html.slice(last.index))!;
  open.index += last.index;
  return inside(html, open, open[1]!.toLowerCase());
}

/** The inside of the first `<main>`, or `undefined`. */
export function mainHtml(html: string): string | undefined {
  const open = /<main\b[^>]*>/i.exec(html);
  return open === null ? undefined : inside(html, open, "main");
}

/** Words in the section `id` of the page, or in its `<main>` when `id` is empty; 0 when it is not there. */
export function wordsOf(html: string, id = ""): number {
  const part = id === "" ? mainHtml(html) : sectionHtml(html, id);
  return part === undefined ? 0 : countWords(part);
}
