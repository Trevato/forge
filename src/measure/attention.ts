/**
 * What a reader sees on first view of a page (#10297), counted from its HTML
 * with no browser: visible words, text blocks and distinct colours, at a phone
 * width and a desktop width. "Visible" is what the stylesheet and the markup
 * decide without a click: `hidden`, `.sr-only`, `.js-only`, the closed body of
 * a `<details>`, and the classes the stylesheet hides at that width
 * (`.hide-sm` under 720 px, `.hide-lg` from 720 px, `.keyhint` to 640 px,
 * `.crumbs` under 720 px). Layout is not simulated: "first view" is the
 * whole visible `<main>`, the stricter reading. Words are counted as
 * `src/measure/words.ts` counts them.
 */
import { mainHtml, textOf } from "./words.ts";

export type Attention = { words: number; blocks: number; colours: number };
export const WIDTHS = [390, 1280] as const;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const GONE = new Set(["script", "style", "template", "noscript", "svg"]);
/** Tags whose text belongs to the nearest block around them: a link in a sentence is not a second block. */
const INLINE = new Set(["a", "span", "b", "i", "em", "strong", "code", "small", "time", "abbr", "mark", "s", "u", "sub", "sup", "kbd", "button", "label"]);
const COLOUR_ATTR = /\b(?:data-variant|data-tone|data-state|data-status)="([^"]+)"/g;
const COLOUR_STYLE = /(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|var\(--[a-z0-9-]*(?:color|accent|ok|warn|bad|danger|green|red|amber|blue)[a-z0-9-]*\))/gi;
const NEUTRAL = new Set(["default", "secondary", "outline", "muted", "none", "neutral"]);

function hiddenClasses(width: number): Set<string> {
  const out = new Set(["sr-only", "js-only"]);
  if (width < 720) {
    out.add("hide-sm");
    out.add("crumbs");
  } else out.add("hide-lg");
  if (width <= 640) out.add("keyhint");
  return out;
}

const attrOf = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s/>]|$)`, "i").exec(tag)?.[1] ?? (new RegExp(`\\s${name}(?=[\\s/>]|$)`, "i").test(tag) ? "" : undefined);

/** The first view of `html` (a whole page or its `<main>`) at `width` px. */
export function firstView(html: string, width: number): Attention {
  const main = mainHtml(html) ?? html;
  const hide = hiddenClasses(width);
  const colours = new Set<string>();
  let words = 0;
  let blocks = 0;
  // Each open element: its tag, whether it hides its subtree, whether it is a
  // closed details (whose summary alone stays), and whether it has text yet.
  const stack: { tag: string; off: boolean; closed: boolean; text: boolean }[] = [];
  const off = (): boolean => stack.some((e) => e.off);
  const tokens = /<!--[\s\S]*?-->|<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>|([^<]+)/gi;
  for (let m = tokens.exec(main); m !== null; m = tokens.exec(main)) {
    if (m[4] !== undefined) {
      const n = textOf(m[4]).split(/\s+/).filter(Boolean).length;
      // Bare text straight inside a closed <details> is as hidden as its elements.
      if (n > 0 && !off() && stack[stack.length - 1]?.closed !== true) {
        words += n;
        const owner = [...stack].reverse().find((e) => !INLINE.has(e.tag));
        if (owner !== undefined && !owner.text) {
          owner.text = true;
          blocks++;
        }
      }
      continue;
    }
    if (m[2] === undefined) continue;
    const tag = m[2].toLowerCase();
    if (m[1] === "/") {
      for (let i = stack.length - 1; i >= 0; i--)
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      continue;
    }
    const attrs = m[3]!;
    if (GONE.has(tag) && !VOID.has(tag)) {
      // Skip to the matching end tag: nothing inside is read.
      const end = new RegExp(`</${tag}\\s*>`, "gi");
      end.lastIndex = tokens.lastIndex;
      const e = end.exec(main);
      tokens.lastIndex = e === null ? main.length : e.index + e[0].length;
      continue;
    }
    const classes = (attrOf(attrs, "class") ?? "").split(/\s+/);
    const parent = stack[stack.length - 1];
    const closedBody = parent?.closed === true && tag !== "summary";
    const here =
      attrOf(attrs, "hidden") !== undefined || classes.some((c) => hide.has(c)) || closedBody ||
      /\baria-hidden="true"/.test(attrs) || attrOf(attrs, "type")?.toLowerCase() === "hidden";
    if (!here && !off()) {
      for (const v of attrs.matchAll(COLOUR_ATTR)) if (!NEUTRAL.has(v[1]!)) colours.add(v[1]!.toLowerCase());
      const style = attrOf(attrs, "style");
      if (style !== undefined) for (const v of style.matchAll(COLOUR_STYLE)) colours.add(v[1]!.toLowerCase().replace(/\s+/g, ""));
    }
    if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) {
      stack.push({ tag, off: here, closed: tag === "details" && attrOf(attrs, "open") === undefined, text: false });
    }
  }
  return { words, blocks, colours: colours.size };
}

/** The line `measure-page --attention` prints for one page: its path, status and first view at each width. */
export const attentionLine = (path: string, status: number, html: string): string =>
  JSON.stringify({ path, status, firstView: Object.fromEntries(WIDTHS.map((w) => [w, firstView(html, w)])) });
