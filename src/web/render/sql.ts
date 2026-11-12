/**
 * A `.sql` file as its schema: one block per statement. A `CREATE TABLE` shows
 * the table name and a row per column (name, type, NOT NULL / PRIMARY KEY /
 * DEFAULT); every other statement is one row with its first line.
 * The reader is its own and small: it splits on `;` outside quotes, comments
 * and parentheses, and reads column definitions at the table's top level.
 * A file with no statement it can recognise, or an unterminated quote or
 * comment, is not drawn: the source view shows with the reason.
 * Postgres `$tag$ … $tag$` bodies are one piece. MySQL backslash escapes inside
 * quotes are not read (standard SQL has none): a `\'` there may split wrongly.
 * Every name is escaped by the template; at most `ROW_CAP` statements are drawn.
 */

import { html, type Html } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export const ROW_CAP = 500;
const COLUMN_CAP = 500;
const LINE_CAP = 200;

export interface SqlColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly default: string;
}

export type SqlStatement =
  | { readonly kind: "table"; readonly name: string; readonly columns: readonly SqlColumn[]; readonly extras: readonly string[] }
  | { readonly kind: "other"; readonly line: string };

export interface SqlDoc {
  readonly statements: readonly SqlStatement[];
  /** Statements in the file, drawn or not. */
  readonly total: number;
}

const VERB = /^(create|alter|drop|insert|update|delete|pragma|begin|commit|rollback|with|select|replace|vacuum|attach|detach|reindex|analyze|grant|revoke|set|comment|truncate|explain|savepoint|release)\b/i;

/** Split into statements with comments removed. Null when a quote or comment never closes. */
function split(source: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "-" && source[i + 1] === "-") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl - 1;
    } else if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 1;
      cur += " ";
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      for (; j < source.length; j++) {
        if (source[j] === close) {
          if (close !== "]" && source[j + 1] === close) j++; // doubled quote
          else break;
        }
      }
      if (j >= source.length) return null;
      cur += source.slice(i, j + 1);
      i = j;
    } else if (ch === "$" && /^\$(?:[A-Za-z_]\w*)?\$/.test(source.slice(i, i + 64)) && (i === 0 || !/\w/.test(source[i - 1]!))) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(source.slice(i, i + 64))![0];
      const end = source.indexOf(tag, i + tag.length);
      if (end === -1) return null;
      cur += source.slice(i, end + tag.length);
      i = end + tag.length - 1;
    } else if (ch === ";" && depth === 0) {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
    } else {
      if (ch === "(") depth++;
      else if (ch === ")" && depth > 0) depth--;
      cur += ch;
    }
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** Split on commas outside quotes and parentheses. */
function parts(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < body.length && !(body[j] === close && (close === "]" || body[j + 1] !== close))) j += body[j] === close ? 2 : 1;
      cur += body.slice(i, j + 1);
      i = j;
    } else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      cur += ch;
    }
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

const unquote = (id: string): string => {
  const q = id[0];
  if (q === "[" && id.endsWith("]")) return id.slice(1, -1);
  if ((q === '"' || q === "`" || q === "'") && id.length >= 2 && id.endsWith(q)) return id.slice(1, -1).replaceAll(q + q, q);
  return id;
};

/** One identifier, possibly quoted, from the start of `s`; then what follows. */
const IDENT = /^(\[[^\]]*\]|"(?:[^"]|"")*"|`(?:[^`]|``)*`|[^\s(),]+)\s*/;

/** A possibly schema-qualified name: `main."my table"`. */
function qualified(s: string): { name: string; rest: string } | null {
  let name = "";
  let rest = s;
  for (let n = 0; n < 3; n++) {
    const m = IDENT.exec(rest);
    if (m === null) return null;
    name += (name === "" ? "" : ".") + unquote(m[1]!);
    rest = rest.slice(m[0].length);
    if (rest[0] === ".") rest = rest.slice(1);
    else break;
  }
  return { name, rest };
}

const STOP = /^(not|null|primary|default|unique|references|check|constraint|collate|generated|autoincrement|auto_increment|as|on|comment)$/i;
const TABLE_LEVEL = /^(constraint|primary|foreign|unique|check|key|index|fulltext|exclude|like)\b/i;

/** A word-boundary-aware first token and the rest, quotes kept whole. */
function tokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i]!)) {
      i++;
      continue;
    }
    const start = i;
    const q = s[i]!;
    if (q === "'" || q === '"' || q === "`" || q === "[") {
      const close = q === "[" ? "]" : q;
      i++;
      while (i < s.length && !(s[i] === close && (close === "]" || s[i + 1] !== close))) i += s[i] === close ? 2 : 1;
      i++;
    } else if (q === "(") {
      let d = 0;
      for (; i < s.length; i++) {
        if (s[i] === "(") d++;
        else if (s[i] === ")" && --d === 0) {
          i++;
          break;
        }
      }
    } else {
      while (i < s.length && !/[\s(]/.test(s[i]!)) i++;
      if (s[i] === "(") {
        // a type like varchar(20): keep its arguments with it
        let d = 0;
        for (; i < s.length; i++) {
          if (s[i] === "(") d++;
          else if (s[i] === ")" && --d === 0) {
            i++;
            break;
          }
        }
      }
    }
    out.push(s.slice(start, i));
  }
  return out;
}

function column(def: string): SqlColumn | null {
  const t = tokens(def);
  if (t.length === 0) return null;
  const name = unquote(t[0]!);
  const type: string[] = [];
  let i = 1;
  while (i < t.length && !STOP.test(t[i]!)) type.push(t[i++]!);
  let notNull = false;
  let primaryKey = false;
  let dflt = "";
  for (; i < t.length; i++) {
    const w = t[i]!.toLowerCase();
    if (w === "not" && t[i + 1]?.toLowerCase() === "null") notNull = true;
    else if (w === "primary" && t[i + 1]?.toLowerCase() === "key") primaryKey = true;
    else if (w === "default" && t[i + 1] !== undefined) dflt = t[i + 1]!;
  }
  return { name, type: type.join(" "), notNull: notNull || primaryKey, primaryKey, default: dflt };
}

/** Column names listed in a table-level `PRIMARY KEY (a, b)`. */
function pkColumns(def: string): string[] {
  const m = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(def);
  return m === null ? [] : parts(m[1]!).map((c) => unquote(c.trim().split(/\s+/)[0]!));
}

function table(stmt: string): SqlStatement | null {
  const m = /^create\s+(?:(?:global\s+|local\s+)?(?:temp|temporary)\s+|virtual\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?/i.exec(stmt);
  if (m === null) return null;
  const q = qualified(stmt.slice(m[0].length));
  if (q === null || q.rest[0] !== "(") return null;
  let depth = 0;
  let end = -1;
  for (let i = 0; i < q.rest.length && end === -1; i++) {
    const ch = q.rest[i]!;
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < q.rest.length && !(q.rest[j] === close && (close === "]" || q.rest[j + 1] !== close))) j += q.rest[j] === close ? 2 : 1;
      i = j;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) end = i;
  }
  if (end === -1) return null;
  const columns: SqlColumn[] = [];
  const extras: string[] = [];
  const keys: string[] = [];
  for (const def of parts(q.rest.slice(1, end))) {
    if (TABLE_LEVEL.test(def)) {
      keys.push(...pkColumns(def));
      extras.push(def.replace(/\s+/g, " "));
    } else {
      const c = column(def);
      if (c !== null) columns.push(c);
    }
  }
  if (columns.length === 0) return null;
  const done = columns.map((c) => (keys.includes(c.name) ? { ...c, primaryKey: true, notNull: true } : c));
  return { kind: "table", name: q.name, columns: done, extras };
}

/** Read a SQL file. Pure; never throws; null when it is not SQL it can read. */
export function parseSql(source: string): SqlDoc | null {
  const stmts = split(source.replace(/^﻿/, ""));
  if (stmts === null || !stmts.some((s) => VERB.test(s))) return null;
  const statements: SqlStatement[] = [];
  for (const s of stmts) {
    if (statements.length >= ROW_CAP) break;
    const t = table(s);
    if (t !== null) {
      statements.push(t.kind === "table" ? { ...t, columns: t.columns.slice(0, COLUMN_CAP) } : t);
    } else {
      const line = (s.split(/\r?\n/)[0] ?? "").trim();
      statements.push({ kind: "other", line: line.length > LINE_CAP ? line.slice(0, LINE_CAP) + "…" : line });
    }
  }
  return { statements, total: stmts.length };
}

const cell = (v: string): string => (v === "" ? "—" : v);

function block(s: SqlStatement): Html {
  if (s.kind === "other") return html`<div class="table-scroll"><table class="table" data-dense aria-label="Statement"><tbody><tr><td><code>${s.line}</code></td></tr></tbody></table></div>`;
  const rows = s.columns.map(
    (c) =>
      html`<tr><th scope="row"><code>${c.name}</code></th><td>${cell(c.type)}</td><td>${c.notNull ? "NOT NULL" : "—"}</td><td>${c.primaryKey ? "PRIMARY KEY" : "—"}</td><td>${cell(c.default)}</td></tr>`,
  );
  const extras = s.extras.length === 0 ? html`` : html`<p class="muted small">${s.extras.join(" · ")}</p>`;
  return html`<h3><code>${s.name}</code></h3><div class="table-scroll"><table class="table" data-dense aria-label="${s.name} columns"><thead><tr><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Null</th><th scope="col">Key</th><th scope="col">Default</th></tr></thead><tbody>${rows}</tbody></table></div>${extras}`;
}

export function sqlView(input: RenderInput): Rendered {
  const doc = parseSql(new TextDecoder().decode(input.body));
  if (doc === null) return { content: html``, lines: 0, fallback: "This file holds no SQL statements to draw." };
  const more = doc.total - doc.statements.length;
  const foot = more > 0 ? html`<p class="muted small">${more.toLocaleString()} more not shown</p>` : html``;
  const content = html`<div class="sql-view">${doc.statements.map(block)}${foot}</div>`;
  const n = doc.total;
  return { content, lines: 0, summary: `${n.toLocaleString()} ${n === 1 ? "statement" : "statements"} · ${fileSize(input.size)}` };
}
