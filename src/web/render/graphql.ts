/**
 * A `.graphql` or `.gql` schema as its shape: one block per `type`, `input`,
 * `interface` and `enum` (and their `extend` forms), each field one row with
 * its type and arguments. `Query`, `Mutation` and `Subscription` come first.
 * The reader is its own and small: it drops comments, then walks definitions
 * at the top level. Anything it does not understand (`union`, `scalar`,
 * `schema`, `directive`, operations, a body it cannot read) is one plain row
 * with its text, never an error. A file with no definition at all is not
 * drawn: the source view shows with the reason.
 * Every name is escaped by the template; at most `BLOCK_CAP` blocks and
 * `FIELD_CAP` rows per block are drawn.
 */

import { html, type Html } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export const BLOCK_CAP = 500;
export const FIELD_CAP = 500;
const TEXT_CAP = 300;

export interface GqlField {
  readonly name: string;
  readonly args: string;
  readonly type: string;
  readonly note: string;
}

export type GqlBlock =
  | { readonly kind: "type" | "input" | "interface" | "enum"; readonly name: string; readonly extend: boolean; readonly header: string; readonly fields: readonly GqlField[]; readonly more: number }
  | { readonly kind: "other"; readonly text: string };

export interface GqlDoc {
  readonly blocks: readonly GqlBlock[];
  readonly total: number;
}

const SHAPES = new Set(["type", "input", "interface", "enum"]);
const DEFINITIONS = new Set(["type", "input", "interface", "enum", "union", "scalar", "schema", "directive", "extend", "fragment", "query", "mutation", "subscription"]);
const ROOTS = ["Query", "Mutation", "Subscription"];

/** Remove `#` comments outside strings; strings are kept whole. */
function stripComments(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (s.startsWith('"""', i)) {
      let end = i + 3;
      while (end < s.length && !(s.startsWith('"""', end) && s[end - 1] !== "\\")) end++;
      out += s.slice(i, end + 3);
      i = end + 2;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"' && s[j] !== "\n") j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (ch === "#") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
    } else out += ch;
  }
  return out;
}

/** Index just past a string starting at `i` (which holds a quote). */
function stringEnd(s: string, i: number): number {
  if (s.startsWith('"""', i)) {
    let end = i + 3;
    while (end < s.length && !(s.startsWith('"""', end) && s[end - 1] !== "\\")) end++;
    return Math.min(s.length, end + 3);
  }
  let j = i + 1;
  while (j < s.length && s[j] !== '"' && s[j] !== "\n") j += s[j] === "\\" ? 2 : 1;
  return Math.min(s.length, j + 1);
}

/** Index just past the bracket group opening at `i`, or -1 when it never closes. */
function groupEnd(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j]!;
    if (ch === '"') j = stringEnd(s, j) - 1;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if ((ch === ")" || ch === "}" || ch === "]") && --depth === 0) return j + 1;
  }
  return -1;
}

const WS = /[\s,﻿]/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string): string => (s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + "…" : s);

function skipSpace(s: string, i: number): number {
  while (i < s.length && WS.test(s[i]!)) i++;
  return i;
}

/** Directives `@name(args)` from `i`; the text of them and where they end. */
function directives(s: string, i: number): { text: string; end: number } {
  const start = i;
  for (;;) {
    let j = skipSpace(s, i);
    if (s[j] !== "@") return { text: squash(s.slice(start, i)), end: i };
    j++;
    const n = NAME.exec(s.slice(j, j + 128));
    if (n === null) return { text: squash(s.slice(start, i)), end: i };
    j += n[0].length;
    if (s[j] === "(") {
      const e = groupEnd(s, j);
      if (e === -1) return { text: squash(s.slice(start, i)), end: i };
      j = e;
    }
    i = j;
  }
}

/** Read the fields of a body (without braces). Null when it is not in a shape this reader knows. */
function fields(body: string, isEnum: boolean): GqlField[] | null {
  const out: GqlField[] = [];
  let i = skipSpace(body, 0);
  while (i < body.length) {
    if (body[i] === '"') {
      i = skipSpace(body, stringEnd(body, i));
      continue;
    }
    const n = NAME.exec(body.slice(i, i + 256));
    if (n === null) return null;
    const name = n[0];
    i += name.length;
    let args = "";
    let type = "";
    if (!isEnum) {
      let j = skipSpace(body, i);
      if (body[j] === "(") {
        const e = groupEnd(body, j);
        if (e === -1) return null;
        args = squash(body.slice(j + 1, e - 1));
        j = skipSpace(body, e);
      }
      if (body[j] !== ":") return null;
      j = skipSpace(body, j + 1);
      // the type is a name in brackets and bangs; the next field's name must not be eaten
      const m = /^(?:\[+\s*)*[A-Za-z_][A-Za-z0-9_]*(?:\s*!)?(?:\s*\]\s*!?)*/.exec(body.slice(j, j + 512));
      if (m === null) return null;
      type = m[0].replace(/\s+/g, "");
      i = j + m[0].length;
      const k = skipSpace(body, i);
      if (body[k] === "=") {
        // a default value, shown with the type
        let v = skipSpace(body, k + 1);
        if (body[v] === "[" || body[v] === "{") {
          const e = groupEnd(body, v);
          if (e === -1) return null;
          v = e;
        } else if (body[v] === '"') v = stringEnd(body, v);
        else {
          const w = /^[^\s,@]+/.exec(body.slice(v, v + 256));
          v += w === null ? 0 : w[0].length;
        }
        type += " " + squash(body.slice(k, v));
        i = v;
      }
    }
    const d = directives(body, i);
    i = skipSpace(body, d.end);
    out.push({ name, args, type, note: d.text });
    if (out.length >= FIELD_CAP + 1) break;
  }
  return out;
}

/** Where an unrecognised definition ends: before the next definition keyword that starts a line. */
function otherEnd(s: string, i: number): number {
  let j = i;
  while (j < s.length) {
    const ch = s[j]!;
    if (ch === '"') j = stringEnd(s, j);
    else if (ch === "{" || ch === "(" || ch === "[") {
      const e = groupEnd(s, j);
      j = e === -1 ? s.length : e;
    } else if (ch === "\n") {
      const k = skipSpace(s, j + 1);
      const w = NAME.exec(s.slice(k, k + 32));
      const prev = s.slice(i, j).trimEnd();
      if (w !== null && DEFINITIONS.has(w[0]) && !/[=|&]$/.test(prev) && !/^extend$/.test(prev.split(/\s+/).pop() ?? "")) return j;
      if (w !== null && /^["{]/.test(s[k] ?? "")) return j;
      j++;
    } else j++;
  }
  return s.length;
}

/** Read a GraphQL schema. Pure; never throws; null when it holds no definition. */
export function parseGraphql(source: string): GqlDoc | null {
  const s = stripComments(source);
  const blocks: GqlBlock[] = [];
  let total = 0;
  let i = skipSpace(s, 0);
  while (i < s.length) {
    // a description belongs to the definition after it
    if (s[i] === '"') {
      i = skipSpace(s, stringEnd(s, i));
      continue;
    }
    const start = i;
    const word = NAME.exec(s.slice(i, i + 32))?.[0] ?? "";
    let block: GqlBlock | null = null;
    let end = -1;
    let k = i;
    let extend = false;
    let kw = word;
    if (word === "extend") {
      extend = true;
      k = skipSpace(s, i + word.length);
      kw = NAME.exec(s.slice(k, k + 32))?.[0] ?? "";
    }
    if (SHAPES.has(kw)) {
      k = skipSpace(s, k + kw.length);
      const name = NAME.exec(s.slice(k, k + 256))?.[0];
      if (name !== undefined) {
        k += name.length;
        // `implements A & B` and directives, until the body
        let h = k;
        const continues = (at: number): boolean => s[at] === "\n" && /^\s*(&|implements\b|@)/.test(s.slice(at, at + 40));
        while (h < s.length && s[h] !== "{" && (s[h] !== "\n" || continues(h))) {
          if (s[h] === "(") {
            const e = groupEnd(s, h);
            if (e === -1) break;
            h = e;
          } else if (s[h] === '"') h = stringEnd(s, h);
          else h++;
        }
        const header = squash(s.slice(k, h));
        if (s[h] === "{") {
          const e = groupEnd(s, h);
          if (e !== -1) {
            const list = fields(s.slice(h + 1, e - 1), kw === "enum");
            if (list !== null) {
              block = { kind: kw as "type", name, extend, header, fields: list.slice(0, FIELD_CAP), more: Math.max(0, list.length - FIELD_CAP) };
              end = e;
            }
          }
        } else {
          // a type with no body: still one block, with no rows
          block = { kind: kw as "type", name, extend, header, fields: [], more: 0 };
          end = h;
        }
      }
    }
    if (block === null) {
      end = otherEnd(s, i + Math.max(1, word.length));
      block = { kind: "other", text: clip(squash(s.slice(start, end))) };
    }
    total++;
    if (blocks.length < BLOCK_CAP) blocks.push(block);
    i = skipSpace(s, Math.max(end, i + 1));
  }
  if (!blocks.some((b) => b.kind !== "other")) return null;
  const rank = (b: GqlBlock): number => {
    const r = b.kind === "other" ? -1 : ROOTS.indexOf(b.name);
    return r === -1 ? ROOTS.length : r;
  };
  const sorted = blocks.map((b, n) => ({ b, n })).sort((a, c) => rank(a.b) - rank(c.b) || a.n - c.n).map((x) => x.b);
  return { blocks: sorted, total };
}

const cell = (v: string): string => (v === "" ? "—" : v);

function block(b: GqlBlock): Html {
  if (b.kind === "other") return html`<div class="table-scroll"><table class="table" data-dense aria-label="Definition"><tbody><tr><td><code>${b.text}</code></td></tr></tbody></table></div>`;
  const label = `${b.extend ? "extend " : ""}${b.kind}`;
  const head = html`<h3><span class="muted small">${label}</span> <code>${b.name}</code></h3>${b.header === "" ? html`` : html`<p class="muted small"><code>${b.header}</code></p>`}`;
  if (b.fields.length === 0) return head;
  const isEnum = b.kind === "enum";
  // a column nobody uses is not drawn: the table stays narrow on a phone
  const notes = b.fields.some((f) => f.note !== "");
  const noteCol = (f: GqlField): Html => (notes ? html`<td>${cell(f.note)}</td>` : html``);
  const noteHead = notes ? html`<th scope="col">Directives</th>` : html``;
  const rows = b.fields.map((f) =>
    isEnum
      ? html`<tr><th scope="row"><code>${f.name}</code></th>${noteCol(f)}</tr>`
      : html`<tr><th scope="row"><code>${f.name}</code></th><td>${f.args === "" ? "—" : html`<code>${f.args}</code>`}</td><td><code>${f.type}</code></td>${noteCol(f)}</tr>`,
  );
  const cols = isEnum
    ? html`<th scope="col">Value</th>${noteHead}`
    : html`<th scope="col">Field</th><th scope="col">Arguments</th><th scope="col">Type</th>${noteHead}`;
  const more = b.more > 0 ? html`<p class="muted small">${b.more.toLocaleString()} more not shown</p>` : html``;
  return html`${head}<div class="table-scroll"><table class="table" data-dense aria-label="${b.name} fields"><thead><tr>${cols}</tr></thead><tbody>${rows}</tbody></table></div>${more}`;
}

export function graphql(input: RenderInput): Rendered {
  const doc = parseGraphql(new TextDecoder().decode(input.body));
  if (doc === null) return { content: html``, lines: 0, fallback: "This file holds no type, input, interface or enum to draw." };
  const more = doc.total - doc.blocks.length;
  const foot = more > 0 ? html`<p class="muted small">${more.toLocaleString()} more not shown</p>` : html``;
  const content = html`<div class="graphql-view">${doc.blocks.map(block)}${foot}</div>`;
  const n = doc.total;
  return { content, lines: 0, summary: `${n.toLocaleString()} ${n === 1 ? "definition" : "definitions"} · ${fileSize(input.size)}` };
}
