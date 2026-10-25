/** A strict little XML reader for tests: well-formedness is checked, not assumed. */
export type XNode = { name: string; attrs: Record<string, string>; kids: XNode[]; text: string };

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };
const unescape = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    const v = ENTITIES[e];
    if (v === undefined) throw new Error(`unknown entity ${m}`);
    return v;
  });

export function parseXml(src: string): XNode {
  const s = src.replace(/^<\?xml[^>]*\?>\s*/, "");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(s)) throw new Error("illegal XML character");
  const root: XNode = { name: "#root", attrs: {}, kids: [], text: "" };
  const stack = [root];
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/gy;
  let at = 0;
  for (let m: RegExpExecArray | null; at < s.length; at = re.lastIndex) {
    re.lastIndex = at;
    m = re.exec(s);
    if (!m) throw new Error(`not well-formed at ${at}: ${s.slice(at, at + 30)}`);
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      if (/[<>]/.test(m[5]) || /&(?![#\w]+;)/.test(m[5])) throw new Error("bad text");
      top.text += unescape(m[5]);
    } else if (m[1] === "/") {
      if (stack.pop()!.name !== m[2]) throw new Error(`mismatched </${m[2]}>`);
    } else {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? "").matchAll(/([\w:.-]+)="([^"]*)"/g)) {
        if (a[1]! in attrs) throw new Error("duplicate attribute");
        attrs[a[1]!] = unescape(a[2]!);
      }
      const node: XNode = { name: m[2]!, attrs, kids: [], text: "" };
      top.kids.push(node);
      if (m[4] !== "/") stack.push(node);
    }
  }
  if (stack.length !== 1 || root.kids.length !== 1) throw new Error("unclosed or multiple roots");
  return root.kids[0]!;
}

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const one = (n: XNode, name: string): XNode => {
  const k = n.kids.filter((c) => c.name === name);
  if (k.length < 1) throw new Error(`<${n.name}> lacks <${name}>`);
  return k[0]!;
};

/** Checks the Atom shape and returns each entry's title, for round-trip checks. */
export function checkAtom(xml: string, url: string): { titles: string[] } {
  const feed = parseXml(xml);
  if (feed.name !== "feed" || feed.attrs["xmlns"] !== "http://www.w3.org/2005/Atom") throw new Error("not an Atom feed");
  for (const f of ["id", "title", "updated"]) if (one(feed, f).text.trim() === "") throw new Error(`empty ${f}`);
  if (!RFC3339.test(one(feed, "updated").text)) throw new Error("feed updated not RFC 3339");
  const self = feed.kids.find((c) => c.name === "link" && c.attrs["rel"] === "self");
  if (!self || self.attrs["href"] !== url) throw new Error(`self link ${self?.attrs["href"]} is not ${url}`);
  const titles: string[] = [];
  const ids = new Set<string>();
  for (const e of feed.kids.filter((c) => c.name === "entry")) {
    const id = one(e, "id").text;
    if (id === "" || ids.has(id)) throw new Error("entry id empty or repeated");
    ids.add(id);
    if (!RFC3339.test(one(e, "updated").text)) throw new Error("entry updated not RFC 3339");
    if (!one(e, "link").attrs["href"]) throw new Error("entry link has no href");
    titles.push(one(e, "title").text);
  }
  return { titles };
}
