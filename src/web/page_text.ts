/**
 * A page as the eye reads it (#5765): HTML in, visible text out. One pass over
 * the tags with a stack of the elements being skipped, so nested tags cannot
 * confuse it. Scripts, styles, templates, the head and anything `hidden` or
 * `aria-hidden="true"` are dropped; link text stays; block elements sit on
 * their own lines; entities are decoded; whitespace is collapsed.
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SKIPPED = new Set(["script", "style", "template", "head", "noscript"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
/** Inline elements that run into their neighbours; every other tag is a word break. */
const RUN = new Set(["abbr", "b", "bdi", "bdo", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd", "mark", "q", "s", "samp", "small", "strong", "sub", "sup", "time", "u", "var", "wbr"]);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", mdash: "—", ndash: "–", rarr: "→", larr: "←" };

function decode(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (m, dec, hex, name) => {
    if (name) return NAMED[name] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

/** True when the tag has a real `hidden` attribute (not `hidden="false"`) or `aria-hidden="true"`; quoted values never count. */
function hides(attrs: string): boolean {
  const re = /([^\s"'=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const m of attrs.matchAll(re)) {
    const name = m[1]!.toLowerCase();
    const value = (m[2] ?? m[3] ?? m[4] ?? "").trim().toLowerCase();
    if (name === "hidden" && value !== "false") return true;
    if (name === "aria-hidden" && value === "true") return true;
  }
  return false;
}

export function pageText(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  const skip: string[] = []; // open elements that are not shown, innermost last
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      if (!skip.length) out += html.slice(i);
      break;
    }
    if (!skip.length) out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(html.slice(lt, lt + 8192));
    if (!m) {
      // Not a tag (`<!doctype`, a lone `<`): drop a declaration, keep a stray `<`.
      const decl = /^<[!?][^>]*>/.exec(html.slice(lt, lt + 8192));
      if (decl) i = lt + decl[0].length;
      else {
        if (!skip.length) out += "<";
        i = lt + 1;
      }
      continue;
    }
    i = lt + m[0].length;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    const attrs = m[3]!;
    if (closing) {
      const at = skip.lastIndexOf(name);
      if (at >= 0) skip.length = at;
      else if (!skip.length && BLOCK.has(name)) out += "\n";
      continue;
    }
    const raw = name === "script" || name === "style";
    if (raw && (skip.length || SKIPPED.has(name))) {
      // Raw-text elements hold no tags: jump to their close.
      const close = lower.indexOf(`</${name}`, i);
      const gt = close < 0 ? -1 : html.indexOf(">", close);
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }
    if (skip.length) {
      if (!VOID.has(name) && !attrs.endsWith("/")) skip.push(name);
      continue;
    }
    if (SKIPPED.has(name) || hides(attrs)) {
      if (!VOID.has(name) && !attrs.endsWith("/")) skip.push(name);
      continue;
    }
    if (BLOCK.has(name)) out += "\n";
    else if (name === "img") {
      const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const text = alt?.[1] ?? alt?.[2];
      if (text) out += ` ${text} `;
    } else if (!RUN.has(name)) out += " ";
  }
  return decode(out)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
