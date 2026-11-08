/**
 * What changed between two config documents, as edits at paths. A format
 * that keeps comments (YAML, TOML) applies these to its own parsed document
 * instead of writing the whole file again, so a line nobody touched stays
 * byte for byte as it was.
 *
 * Key order is not an edit: the form never reorders keys, and a format that
 * keeps the file's order keeps it.
 */

import { stringify, type Json } from "./json-doc.ts";

/** Keys and array indexes from the document's root to a value. */
export type Path = readonly (string | number)[];

export type Edit =
  /** Put `value` at `path`: replace it, add the key, or (index == length) append. */
  | { readonly op: "set"; readonly path: Path; readonly value: Json }
  /** Remove the key, or the array item (later items shift down). */
  | { readonly op: "remove"; readonly path: Path };

/** The edits that turn `before` into `after`, in an order that is safe to apply one by one. */
export function editsBetween(before: Json, after: Json, path: Path = []): Edit[] {
  if (before.t === "object" && after.t === "object") {
    const out: Edit[] = [];
    const kept = new Map(after.entries);
    for (const [k] of before.entries) if (!kept.has(k)) out.push({ op: "remove", path: [...path, k] });
    const had = new Map(before.entries);
    for (const [k, v] of after.entries) {
      const old = had.get(k);
      if (old === undefined) out.push({ op: "set", path: [...path, k], value: v });
      else out.push(...editsBetween(old, v, [...path, k]));
    }
    return out;
  }
  if (before.t === "array" && after.t === "array") {
    const out: Edit[] = [];
    const common = Math.min(before.items.length, after.items.length);
    for (let i = 0; i < common; i++) out.push(...editsBetween(before.items[i]!, after.items[i]!, [...path, i]));
    // Highest first, so each index is still the one that was meant.
    for (let i = before.items.length - 1; i >= common; i--) out.push({ op: "remove", path: [...path, i] });
    for (let i = common; i < after.items.length; i++) out.push({ op: "set", path: [...path, i], value: after.items[i]! });
    return out;
  }
  return stringify(before) === stringify(after) ? [] : [{ op: "set", path, value: after }];
}

/** A value as plain data, for a library that takes plain data. Numbers past 2^53 stay exact as bigint. */
export function plainOf(v: Json): unknown {
  switch (v.t) {
    case "string":
      return v.v;
    case "number": {
      const n = Number(v.v);
      return /^-?\d+$/.test(v.v) && !Number.isSafeInteger(n) ? BigInt(v.v) : n;
    }
    case "boolean":
      return v.v;
    case "null":
      return null;
    case "array":
      return v.items.map(plainOf);
    case "object":
      return Object.fromEntries(v.entries.map(([k, x]) => [k, plainOf(x)]));
  }
}
