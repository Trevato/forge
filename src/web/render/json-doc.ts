/**
 * A JSON document as the config form holds it: ordered, exact, and written
 * back in the file's own style.
 *
 * `JSON.parse` loses two things the form must keep: the order of keys that
 * look like integers (an object puts those first) and the spelling of a
 * number (`1.0` comes back `1`). So a document is parsed here into plain
 * data — objects as ordered entries, numbers as their source text — and a
 * parse error names its line and column, which `JSON.parse` does not.
 *
 * Plain data in, plain data out; nothing here knows about HTML.
 */

export type Json =
  | { readonly t: "string"; readonly v: string }
  /** The number's own text, so `1.0` stays `1.0`. */
  | { readonly t: "number"; readonly v: string }
  | { readonly t: "boolean"; readonly v: boolean }
  | { readonly t: "null" }
  | { readonly t: "array"; readonly items: readonly Json[] }
  | { readonly t: "object"; readonly entries: readonly (readonly [string, Json])[] };

export interface ParseError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export type Parsed =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly error: ParseError };

/** Deeper than this is not a config file a person edits in a form. */
const MAX_DEPTH = 64;

export const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

class Stop extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

/** Parse strict JSON (RFC 8259) into a `Json`, or say where it went wrong. */
export function parseJson(text: string): Parsed {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const fail = (message: string): never => {
    throw new Stop(message, i);
  };
  const expect = (word: string): void => {
    if (text.startsWith(word, i)) i += word.length;
    else fail(`Expected ${word}`);
  };
  const str = (): string => {
    i++; // the opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) fail("Unterminated string");
      const c = text[i]!;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const e = text[i + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e !== undefined && simple[e] !== undefined) {
          out += simple[e];
          i += 2;
        } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else fail("Bad escape in string");
        continue;
      }
      if (c.charCodeAt(0) < 0x20) fail("Control character in string");
      out += c;
      i++;
    }
  };
  const value = (depth: number): Json => {
    if (depth > MAX_DEPTH) fail("Nested too deeply");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const entries: [string, Json][] = [];
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return { t: "object", entries };
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("Expected a key in quotes");
        const keyAt = i;
        const key = str();
        if (seen.has(key)) throw new Stop(`Duplicate key "${key}"`, keyAt);
        seen.add(key);
        ws();
        expect(":");
        entries.push([key, value(depth + 1)]);
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") {
          i++;
          return { t: "object", entries };
        } else fail("Expected , or }");
      }
    }
    if (c === "[") {
      i++;
      const items: Json[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return { t: "array", items };
      }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") {
          i++;
          return { t: "array", items };
        } else fail("Expected , or ]");
      }
    }
    if (c === '"') return { t: "string", v: str() };
    if (c === "t") return expect("true"), { t: "boolean", v: true };
    if (c === "f") return expect("false"), { t: "boolean", v: false };
    if (c === "n") return expect("null"), { t: "null" };
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (m === null || m[0] === "" || m[0] === "-") return fail(c === undefined ? "Unexpected end of file" : `Unexpected ${JSON.stringify(c)}`);
    i += m[0].length;
    return { t: "number", v: m[0] };
  };
  try {
    // A byte-order mark is not JSON, but editors write one.
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    const v = value(0);
    ws();
    if (i < text.length) fail("Unexpected text after the value");
    return { ok: true, value: v };
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    const before = text.slice(0, e.at);
    const line = before.split("\n").length;
    return {
      ok: false,
      error: { message: e.message, line, column: e.at - before.lastIndexOf("\n") },
    };
  }
}

/** How a file lays itself out, so a save writes it back the same way. */
export interface Style {
  /** "" for a one-line file; else the indent unit (spaces or a tab). */
  readonly indent: string;
  readonly eol: "\n" | "\r\n";
  readonly finalNewline: boolean;
}

export function detectStyle(text: string): Style {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = text.replace(/\s+$/, "");
  const indented = /\n([ \t]+)\S/.exec(body);
  return {
    indent: !body.includes("\n") ? "" : (indented?.[1] ?? "  "),
    eol,
    finalNewline: /\n$/.test(text),
  };
}

/** The document as text, in `style`: arrays and objects open one per line. */
export function stringify(doc: Json, style: Style = { indent: "", eol: "\n", finalNewline: false }): string {
  const nl = style.indent === "" ? "" : style.eol;
  const colon = style.indent === "" ? ":" : ": ";
  const write = (v: Json, pad: string): string => {
    const inner = pad + style.indent;
    switch (v.t) {
      case "string":
        return JSON.stringify(v.v);
      case "number":
        return v.v;
      case "boolean":
        return v.v ? "true" : "false";
      case "null":
        return "null";
      case "array":
        if (v.items.length === 0) return "[]";
        return `[${nl}${v.items.map((x) => inner + write(x, inner)).join(`,${nl}`)}${nl}${pad}]`;
      case "object":
        if (v.entries.length === 0) return "{}";
        return `{${nl}${v.entries
          .map(([k, x]) => `${inner}${JSON.stringify(k)}${colon}${write(x, inner)}`)
          .join(`,${nl}`)}${nl}${pad}}`;
    }
  };
  return write(doc, "") + (style.finalNewline ? style.eol : "");
}

/** Whether two documents say the same thing, key order included. */
export const sameDoc = (a: Json, b: Json): boolean => stringify(a) === stringify(b);

// ---- pointers (RFC 6901), the form's field names ----

export const pointer = (parent: string, key: string | number): string =>
  `${parent}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;

export function splitPointer(p: string): string[] | undefined {
  if (p === "") return [];
  if (!p.startsWith("/")) return undefined;
  return p
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** The value at `p`, if there is one. */
export function getAt(doc: Json, p: string): Json | undefined {
  const parts = splitPointer(p);
  if (parts === undefined) return undefined;
  let at: Json | undefined = doc;
  for (const part of parts) {
    if (at === undefined) return undefined;
    if (at.t === "object") at = at.entries.find(([k]) => k === part)?.[1];
    else if (at.t === "array" && /^(0|[1-9]\d*)$/.test(part)) at = at.items[Number(part)];
    else return undefined;
  }
  return at;
}

/**
 * A copy of `doc` with the value at `p` replaced by `change(old)`. A path
 * that names nothing leaves the document as it was.
 */
export function updateAt(doc: Json, p: string, change: (old: Json) => Json): Json {
  const parts = splitPointer(p);
  if (parts === undefined) return doc;
  const walk = (at: Json, rest: string[]): Json => {
    const [head, ...tail] = rest;
    if (head === undefined) return change(at);
    if (at.t === "object") {
      if (!at.entries.some(([k]) => k === head)) return at;
      return { t: "object", entries: at.entries.map(([k, v]) => [k, k === head ? walk(v, tail) : v] as const) };
    }
    if (at.t === "array" && /^(0|[1-9]\d*)$/.test(head)) {
      const n = Number(head);
      if (n >= at.items.length) return at;
      return { t: "array", items: at.items.map((v, j) => (j === n ? walk(v, tail) : v)) };
    }
    return at;
  };
  return walk(doc, parts);
}

/** An empty value shaped like `like`: what a new card or chip starts as. */
export function blankLike(like: Json | undefined): Json {
  if (like === undefined) return { t: "string", v: "" };
  switch (like.t) {
    case "string":
      return { t: "string", v: "" };
    case "number":
      return { t: "number", v: "0" };
    case "boolean":
      return { t: "boolean", v: false };
    case "null":
      return { t: "null" };
    case "array":
      return { t: "array", items: [] };
    case "object":
      return { t: "object", entries: like.entries.map(([k, v]) => [k, blankLike(v)] as const) };
  }
}

/** From a value `JSON.parse` made (a schema's default, an enum member). */
export function fromPlain(v: unknown): Json {
  if (typeof v === "string") return { t: "string", v };
  if (typeof v === "number" && Number.isFinite(v)) return { t: "number", v: String(v) };
  if (typeof v === "boolean") return { t: "boolean", v };
  if (Array.isArray(v)) return { t: "array", items: v.map(fromPlain) };
  if (v !== null && typeof v === "object")
    return { t: "object", entries: Object.entries(v).map(([k, x]) => [k, fromPlain(x)] as const) };
  return { t: "null" };
}

/** Lines of `before` and `after` as a unified-style list, unchanged runs trimmed to context. */
export interface DiffLine {
  readonly op: " " | "-" | "+";
  readonly text: string;
}

/** Past this many changed lines each side, the diff shows the whole swap. */
const DIFF_LCS_MAX = 1_000;

export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid: DiffLine[] = [];
  if (midA.length > DIFF_LCS_MAX || midB.length > DIFF_LCS_MAX) {
    for (const t of midA) mid.push({ op: "-", text: t });
    for (const t of midB) mid.push({ op: "+", text: t });
  } else {
    // Longest common subsequence, then walked forwards.
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let x = n - 1; x >= 0; x--)
      for (let y = m - 1; y >= 0; y--)
        lcs[x]![y] = midA[x] === midB[y] ? lcs[x + 1]![y + 1]! + 1 : Math.max(lcs[x + 1]![y]!, lcs[x]![y + 1]!);
    let x = 0;
    let y = 0;
    while (x < n || y < m) {
      if (x < n && y < m && midA[x] === midB[y]) mid.push({ op: " ", text: midA[x++]! }), y++;
      else if (y < m && (x === n || lcs[x]![y + 1]! >= lcs[x + 1]![y]!)) mid.push({ op: "+", text: midB[y++]! });
      else mid.push({ op: "-", text: midA[x++]! });
    }
  }
  const all: DiffLine[] = [
    ...a.slice(0, start).map((text) => ({ op: " " as const, text })),
    ...mid,
    ...a.slice(endA).map((text) => ({ op: " " as const, text })),
  ];
  // Keep only the context around a change.
  const near = all.map(() => false);
  all.forEach((l, k) => {
    if (l.op === " ") return;
    for (let j = Math.max(0, k - context); j <= Math.min(all.length - 1, k + context); j++) near[j] = true;
  });
  return all.filter((_, k) => near[k]);
}
