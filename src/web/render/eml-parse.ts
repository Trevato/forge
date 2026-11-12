/**
 * A mail message (`.eml`, RFC 5322 with MIME) as plain data: the headers a
 * reader wants, the first text/plain body (or the text of an HTML-only one,
 * tags stripped), and the attachments by name, type and size. Headers are
 * unfolded and RFC 2047 encoded words decoded; quoted-printable and base64
 * bodies decoded; UTF-8 and latin-1 (and any charset TextDecoder knows)
 * read. Pure; never throws; nothing here is markup: the caller escapes and
 * HTML is never kept, only its text.
 */

export const HEADER_ROWS = ["From", "To", "Cc", "Subject", "Date"] as const;
/** Parts walked and nesting followed, whatever the file holds. */
const PART_CAP = 200;
const DEPTH_CAP = 6;

export interface Attachment {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export interface Eml {
  /** Only the headers the message has, in `HEADER_ROWS` order. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
  /** The body came from text/html with its tags stripped. */
  readonly fromHtml: boolean;
  readonly attachments: readonly Attachment[];
}

const latin1 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};
const toBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** Bytes as text in a charset: UTF-8 when it is valid, else the named one, else latin-1. */
function decodeText(bytes: Uint8Array, charset: string): string {
  const cs = charset.trim().toLowerCase();
  try {
    return new TextDecoder((cs === "" || cs === "us-ascii" ? "utf-8" : cs) as "utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder("windows-1252" as "utf-8").decode(bytes);
    }
  }
}

function qpBytes(s: string, header: boolean): Uint8Array {
  const text = header ? s.replace(/_/g, " ") : s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const hex = c === "=" ? text.slice(i + 1, i + 3) : "";
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else out.push(text.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

function b64Bytes(s: string): Uint8Array {
  try {
    const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
    return Uint8Array.from(atob(clean.slice(0, clean.length - (clean.length % 4 === 1 ? 1 : 0))), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
}

/** RFC 2047: `=?utf-8?Q?caf=C3=A9?=` and `=?iso-8859-1?B?...?=` anywhere in a value. */
export function decodeWords(value: string): string {
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=/g, (_m, cs: string, enc: string, data: string) => {
    const bytes = enc.toLowerCase() === "b" ? b64Bytes(data) : qpBytes(data, true);
    return decodeText(bytes, cs.split("*")[0]!);
  });
}

interface Header {
  readonly name: string;
  readonly value: string;
}

function parseHeaders(block: string): Header[] {
  const out: Header[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      const last = out[out.length - 1]!;
      out[out.length - 1] = { name: last.name, value: `${last.value} ${line.trim()}` };
      continue;
    }
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (m !== null) out.push({ name: m[1]!.toLowerCase(), value: m[2]!.trim() });
  }
  return out;
}

const get = (hs: readonly Header[], name: string): string => hs.find((h) => h.name === name)?.value ?? "";

/** `type/sub; a=b; c="d"` as the lowercased type and its parameters. */
function structured(value: string): { type: string; params: Map<string, string> } {
  const params = new Map<string, string>();
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    params.set(key, v);
  }
  return { type: parts[0]!.trim().toLowerCase(), params };
}

/** The filename of a part: RFC 2231 `filename*=utf-8''…`, else `filename`, else the type's `name`. */
function fileName(disposition: ReturnType<typeof structured>, type: ReturnType<typeof structured>): string {
  const star = disposition.params.get("filename*") ?? type.params.get("name*");
  if (star !== undefined) {
    const m = /^([^']*)'[^']*'(.*)$/.exec(star);
    if (m !== null) {
      try {
        return decodeText(qpBytes(m[2]!.replace(/%([0-9a-fA-F]{2})/g, "=$1"), false), m[1]!);
      } catch {
        /* fall through */
      }
    }
  }
  const plain = disposition.params.get("filename") ?? type.params.get("name") ?? "";
  return decodeWords(plain);
}

function decodeBody(raw: string, encoding: string): Uint8Array {
  const e = encoding.trim().toLowerCase();
  if (e === "base64") return b64Bytes(raw);
  if (e === "quoted-printable") return qpBytes(raw, false);
  return toBytes(raw);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The text of an HTML body: scripts and styles dropped, tags stripped, entities undone. */
export function htmlText(source: string): string {
  return source
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>?/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : "";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Walk {
  plain: string | undefined;
  html: string | undefined;
  attachments: Attachment[];
  parts: number;
}

function splitHead(text: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(text);
  return m === null ? [text, ""] : [text.slice(0, m.index), text.slice(m.index + m[0].length)];
}

function walk(hs: readonly Header[], raw: string, w: Walk, depth: number): void {
  if (++w.parts > PART_CAP) return;
  const type = structured(get(hs, "content-type") || "text/plain");
  const disp = structured(get(hs, "content-disposition"));
  if (type.type.startsWith("multipart/") && depth < DEPTH_CAP) {
    const boundary = type.params.get("boundary");
    if (boundary === undefined || boundary === "") return;
    const marker = `--${boundary}`;
    const lines = raw.split(/\r?\n/);
    let cur: string[] | null = null;
    const chunks: string[] = [];
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line === `${marker}--`) {
        if (cur !== null) chunks.push(cur.join("\n"));
        cur = null;
        break;
      }
      if (line === marker) {
        if (cur !== null) chunks.push(cur.join("\n"));
        cur = [];
      } else if (cur !== null) cur.push(line);
    }
    if (cur !== null) chunks.push(cur.join("\n"));
    for (const chunk of chunks) {
      // A part with no headers starts with the blank line that ends them: its whole chunk is body.
      const [head, body] = chunk.startsWith("\n") ? ["", chunk.slice(1)] : splitHead(chunk);
      walk(parseHeaders(head), body, w, depth + 1);
    }
    return;
  }
  const bytes = decodeBody(raw, get(hs, "content-transfer-encoding"));
  const name = fileName(disp, type);
  const isText = type.type === "text/plain" || type.type === "text/html";
  if (isText && disp.type !== "attachment" && name === "") {
    const text = decodeText(bytes, type.params.get("charset") ?? "");
    if (type.type === "text/plain") w.plain ??= text;
    else w.html ??= text;
    return;
  }
  if (type.type.startsWith("multipart/")) return;
  w.attachments.push({ name: name === "" ? "(unnamed)" : name, type: type.type, size: bytes.length });
}

/** The message, or the reason it is not one. */
export function parseEml(bytes: Uint8Array): Eml | { error: string } {
  const text = latin1(bytes);
  const [head, body] = splitHead(text.replace(/^﻿|^\xEF\xBB\xBF/, ""));
  const hs = parseHeaders(head);
  if (hs.length === 0 || !/^[!-9;-~]+:/.test(head)) return { error: "it does not begin with mail headers" };
  if (!hs.some((h) => ["from", "to", "subject", "date", "message-id", "mime-version", "received"].includes(h.name)))
    return { error: "it has none of From, To, Subject or Date" };
  const headers = HEADER_ROWS.flatMap((n): [string, string][] => {
    const v = get(hs, n.toLowerCase());
    return v === "" ? [] : [[n, decodeWords(v)]];
  });
  const w: Walk = { plain: undefined, html: undefined, attachments: [], parts: 0 };
  walk(hs, body, w, 0);
  const fromHtml = w.plain === undefined && w.html !== undefined;
  const out = w.plain ?? (w.html === undefined ? "" : htmlText(w.html));
  return { headers, body: out.replace(/\r\n?/g, "\n").trim(), fromHtml, attachments: w.attachments };
}
