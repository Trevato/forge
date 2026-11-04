/**
 * TOML as the config form holds it (#7337): `toml-patch` reads it into a
 * `Json`, and a save patches the original text with only the values that
 * changed, so comments, table order and the spacing of every untouched line
 * stay as written.
 *
 * Dates and times have no `Json` type: they show as the text they were
 * written as, and writing text that parses as a date back over one keeps it
 * a date. TOML has no null; a form that would write one is refused.
 */

import { parse, patch } from "./vendor/toml-patch.mjs";
import { editsBetween, plainOf } from "./config-diff.ts";
import type { Json, ParseError } from "./json-doc.ts";

export type TomlParsed =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly error: ParseError };

const MAX_DEPTH = 64;

/** A date, time or date-time: the parser's own subclasses of `Date`. */
const isDate = (v: unknown): v is Date => v instanceof Date;

function toJson(v: unknown, depth: number): Json {
  if (depth > MAX_DEPTH) throw new RangeError("nested too deeply");
  if (typeof v === "string") return { t: "string", v };
  if (typeof v === "boolean") return { t: "boolean", v };
  // inf and nan have no JSON spelling: shown as text, which only an edit changes.
  if (typeof v === "number") return Number.isFinite(v) ? { t: "number", v: String(v) } : { t: "string", v: v > 0 ? "inf" : v < 0 ? "-inf" : "nan" };
  if (typeof v === "bigint") return { t: "number", v: String(v) };
  if (isDate(v)) return { t: "string", v: v.toISOString() };
  if (Array.isArray(v)) return { t: "array", items: v.map((x) => toJson(x, depth + 1)) };
  if (v !== null && typeof v === "object")
    return { t: "object", entries: Object.entries(v).map(([k, x]) => [k, toJson(x, depth + 1)] as const) };
  return { t: "null" };
}

const reason = (e: unknown): { message: string; line: number; column: number } => {
  const err = e as { message?: string; line?: number; column?: number };
  const lines = String(err.message ?? "invalid TOML").split("\n");
  return { message: lines[lines.length - 1]!, line: err.line ?? 1, column: (err.column ?? 0) + 1 };
};

export function parseToml(text: string): TomlParsed {
  try {
    return { ok: true, value: toJson(parse(text), 0) };
  } catch (e) {
    return { ok: false, error: reason(e) };
  }
}

export type TomlWritten = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

const hasNull = (v: Json): boolean =>
  v.t === "null" || (v.t === "array" && v.items.some(hasNull)) || (v.t === "object" && v.entries.some(([, x]) => hasNull(x)));

type Container = Record<string | number, unknown>;

const isContainer = (v: unknown): v is Container => v !== null && typeof v === "object";

/** The table or array a path's parent names, or undefined when the tree has no such place. */
function parentOf(tree: unknown, path: readonly (string | number)[]): Container | undefined {
  let at: unknown = tree;
  for (const k of path.slice(0, -1)) {
    if (!isContainer(at)) return undefined;
    at = at[k];
  }
  return isContainer(at) ? at : undefined;
}

/** `text` as a TOML date, time or date-time, or undefined when it does not read as one. */
function asDate(text: string): Date | undefined {
  try {
    const probe: unknown = parse(`v = ${text}`)["v"];
    return isDate(probe) ? probe : undefined;
  } catch {
    // Text that is not a date is the common case, not a fault: it stays text.
    return undefined;
  }
}

const UNWRITABLE = "This change cannot be written into the TOML without losing its structure. Edit it as text.";

/** `original` with the edits from `before` to `after` patched in. */
export function writeToml(original: string, before: Json, after: Json): TomlWritten {
  const edits = editsBetween(before, after);
  if (edits.length === 0) return { ok: true, text: original };
  if (hasNull(after)) return { ok: false, message: "TOML has no null, so a field cannot be left empty. Give it a value, or edit the file as text." };
  try {
    const tree = parse(original);
    for (const edit of edits) {
      const parent = parentOf(tree, edit.path);
      const key = edit.path[edit.path.length - 1];
      if (parent === undefined || key === undefined) return { ok: false, message: UNWRITABLE };
      if (edit.op === "remove") {
        if (Array.isArray(parent) && typeof key === "number") parent.splice(key, 1);
        else delete parent[key];
        continue;
      }
      let value = plainOf(edit.value);
      // Text over a date stays a date, when it still reads as one.
      if (isDate(parent[key]) && typeof value === "string") value = asDate(value) ?? value;
      parent[key] = value;
    }
    return { ok: true, text: patch(original, tree) };
  } catch {
    return { ok: false, message: UNWRITABLE };
  }
}
