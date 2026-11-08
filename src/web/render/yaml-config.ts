/**
 * YAML as the config form holds it (#7337): the `yaml` package's Document
 * API reads it into a `Json`, and a save edits that same Document, so
 * comments, anchors, quoting and key order survive and an untouched line is
 * written byte for byte as it was.
 *
 * A file of several documents (`---`) reads as one object whose keys are
 * "Document 1", "Document 2" …, so the form draws one fieldset each. An
 * alias reads as the value it points at; changing a value that only an
 * alias holds is refused rather than guessed.
 */

import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Document } from "./vendor/yaml.mjs";
import { editsBetween, plainOf, type Path } from "./config-diff.ts";
import { MAX_FIELDS } from "./config-form.ts";
import type { Json, ParseError } from "./json-doc.ts";

export type YamlParsed =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly error: ParseError };

const MAX_DEPTH = 64;

class Unsupported extends Error {}

const docKey = (i: number): string => `Document ${i + 1}`;

function toJson(doc: Document, node: unknown, depth: number, budget: { left: number }): Json {
  if (depth > MAX_DEPTH) throw new Unsupported("nested too deeply");
  // Aliases can fan out (a few lines of YAML naming a billion values).
  if (--budget.left < 0) throw new Unsupported(`more than ${MAX_FIELDS.toLocaleString()} values`);
  if (node === null || node === undefined) return { t: "null" };
  if (isAlias(node)) return toJson(doc, node.resolve(doc), depth + 1, budget);
  if (isScalar(node)) {
    const v = node.value;
    if (v === null || v === undefined) return { t: "null" };
    if (typeof v === "string") return { t: "string", v };
    if (typeof v === "boolean") return { t: "boolean", v };
    if (typeof v === "number" && Number.isFinite(v)) return { t: "number", v: String(v) };
    if (typeof v === "bigint") return { t: "number", v: String(v) };
    // .inf, .nan, binary and the like: shown as the text they were written as.
    return { t: "string", v: node.source ?? String(v) };
  }
  if (isMap(node)) {
    const entries: (readonly [string, Json])[] = [];
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string")
        throw new Unsupported("a key that is not plain text");
      entries.push([pair.key.value, toJson(doc, pair.value, depth + 1, budget)]);
    }
    return { t: "object", entries };
  }
  if (isSeq(node)) return { t: "array", items: node.items.map((x) => toJson(doc, x, depth + 1, budget)) };
  throw new Unsupported("a value of a kind the form does not hold");
}

/** The first problem in any document, or undefined. */
function firstError(docs: readonly Document[]): ParseError | undefined {
  for (const d of docs) {
    const e = d.errors[0];
    if (e === undefined) continue;
    const at = e.linePos?.[0];
    return { message: e.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, ""), line: at?.line ?? 1, column: at?.col ?? 1 };
  }
  return undefined;
}

export function parseYaml(text: string): YamlParsed {
  const docs = parseAllDocuments(text, { prettyErrors: true });
  const error = firstError(docs);
  if (error !== undefined) return { ok: false, error };
  try {
    const budget = { left: MAX_FIELDS * 2 };
    const values = docs.map((d) => toJson(d, d.contents, 0, budget));
    if (values.length === 1) return { ok: true, value: values[0]! };
    return { ok: true, value: { t: "object", entries: values.map((v, i) => [docKey(i), v] as const) } };
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    return { ok: false, error: { message: `The form cannot hold ${e.message}`, line: 1, column: 1 } };
  }
}

/** How the file indents, so the rewritten lines match the untouched ones. */
function layout(text: string): { indent: number; indentSeq: boolean } {
  let indent = 0;
  for (const line of text.split("\n")) {
    const m = /^( +)[^\s#]/.exec(line);
    if (m !== null && (indent === 0 || m[1]!.length < indent)) indent = m[1]!.length;
  }
  // `key:` then `- item` at the key's own column.
  const flush = /^( *)[^\s#-][^\n]*:[ \t]*\r?\n\1- /m.test(text);
  const deep = /^( *)[^\s#-][^\n]*:[ \t]*\r?\n\1 +- /m.test(text);
  return { indent: Math.min(Math.max(indent, 2), 8), indentSeq: !(flush && !deep) };
}

export type YamlWritten = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/** `original` with `after` written into it; only the documents that changed are rewritten. */
export function writeYaml(original: string, before: Json, after: Json): YamlWritten {
  const docs = parseAllDocuments(original);
  const multi = docs.length > 1;
  const edits = editsBetween(before, after);
  if (edits.length === 0) return { ok: true, text: original };
  const changed = new Set<number>();
  try {
    for (const edit of edits) {
      let path: Path = edit.path;
      let index = 0;
      if (multi) {
        const [head, ...rest] = path;
        index = typeof head === "string" ? Number(/^Document (\d+)$/.exec(head)?.[1]) - 1 : NaN;
        if (!(index >= 0 && index < docs.length) || rest.length === 0) throw new Unsupported("a whole document");
        path = rest;
      } else if (path.length === 0) throw new Unsupported("the whole file");
      const doc = docs[index]!;
      if (edit.op === "remove") doc.deleteIn(path);
      else doc.setIn(path, plainOf(edit.value));
      changed.add(index);
    }
  } catch (e) {
    const why = e instanceof Unsupported ? e.message : "a value that comes from an alias or an unusual node";
    return { ok: false, message: `This change cannot be written into the YAML without losing its structure (${why}). Edit it as text.` };
  }
  const { indent, indentSeq } = layout(original);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const cuts = docs.map((d, i) => (i === 0 ? 0 : d.range[0]));
  let out = "";
  docs.forEach((d, i) => {
    const end = i + 1 < docs.length ? cuts[i + 1]! : original.length;
    out += changed.has(i)
      ? d.toString({ lineWidth: 0, indent, indentSeq }).replace(/\n/g, eol)
      : original.slice(cuts[i]!, end);
  });
  if (!/\n$/.test(original)) out = out.replace(/\r?\n$/, "");
  return { ok: true, text: out };
}
