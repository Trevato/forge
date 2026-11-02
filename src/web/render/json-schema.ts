/**
 * The part of JSON Schema the config form uses: which fields there are, what
 * type each holds, the choices an enum allows, the help text, and the bounds
 * a save is checked against. Anything else in a schema is ignored, never an
 * error: a schema written for another tool still draws a better form.
 *
 * Where the schema comes from, first found wins (`findSchema`):
 *   1. `$schema` in the file, when it is a path in the repository;
 *   2. a sibling `<name>.schema.json`;
 *   3. `.forge/schemas.json`, an object mapping globs to schema paths.
 *
 * `pattern` is drawn as the input's own `pattern` attribute, checked in the
 * browser; the server never runs a regular expression a repository wrote.
 */

import { isFormConfig, parseConfig } from "./config-format.ts";
import { NUMBER, getAt, pointer, splitPointer, type Json } from "./json-doc.ts";

export interface Schema {
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly items?: Schema;
  readonly required?: readonly string[];
  readonly enum?: readonly unknown[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly default?: unknown;
  readonly $ref?: string;
}

/** A schema with the document it came from, for `$ref` inside it. */
export interface FoundSchema {
  readonly root: Schema;
  /** The repository path it was read from. */
  readonly from: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A schema file's text as a `Schema`, or undefined when it is not one. */
export function parseSchema(text: string): Schema | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? (v as Schema) : undefined;
  } catch {
    return undefined;
  }
}

/** Follow a local `$ref` (`#/definitions/x`, `#/$defs/x`), a few hops at most. */
function deref(root: Schema, s: Schema | undefined): Schema | undefined {
  let at = s;
  for (let hops = 0; at?.$ref !== undefined && hops < 8; hops++) {
    if (!at.$ref.startsWith("#")) return at;
    let next: unknown = root;
    for (const part of splitPointer(at.$ref.slice(1)) ?? []) next = isObject(next) ? next[part] : undefined;
    at = isObject(next) ? (next as Schema) : undefined;
  }
  return isObject(at) ? at : undefined;
}

/** The schema that describes the value at pointer `p`, if the schema says. */
export function schemaAt(found: FoundSchema | undefined, p: string): Schema | undefined {
  if (found === undefined) return undefined;
  let at = deref(found.root, found.root);
  for (const part of splitPointer(p) ?? []) {
    if (at === undefined) return undefined;
    at = /^(0|[1-9]\d*)$/.test(part) && isObject(at.items)
      ? deref(found.root, at.items)
      : deref(found.root, isObject(at.properties) ? at.properties[part] : undefined);
  }
  return at;
}

const typeOf = (v: Json): string => (v.t === "number" && /^-?\d+$/.test(v.v) ? "integer" : v.t);

const typeAllows = (s: Schema, v: Json): boolean => {
  if (s.type === undefined) return true;
  const types = typeof s.type === "string" ? [s.type] : s.type;
  const t = typeOf(v);
  return types.includes(t) || (t === "integer" && types.includes("number"));
};

/** A JSON value as the plain value an enum lists, for comparing. */
const plain = (v: Json): unknown =>
  v.t === "number" ? Number(v.v) : v.t === "null" ? null : v.t === "string" || v.t === "boolean" ? v.v : undefined;

/**
 * What is wrong with `doc` by the schema, as messages keyed by pointer: a
 * field's own error sits under that field. Empty when the document passes.
 */
export function validate(doc: Json, found: FoundSchema | undefined): Map<string, string> {
  const errors = new Map<string, string>();
  if (found === undefined) return errors;
  const walk = (v: Json, s: Schema | undefined, p: string): void => {
    if (s === undefined) return;
    if (!typeAllows(s, v)) {
      errors.set(p, `Must be ${typeof s.type === "string" ? s.type : (s.type ?? []).join(" or ")}.`);
      return;
    }
    if (Array.isArray(s.enum) && !s.enum.some((e) => e === plain(v)))
      errors.set(p, `Must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}.`);
    if (v.t === "number") {
      const n = Number(v.v);
      if (typeof s.minimum === "number" && n < s.minimum) errors.set(p, `Must be at least ${s.minimum}.`);
      if (typeof s.maximum === "number" && n > s.maximum) errors.set(p, `Must be at most ${s.maximum}.`);
    }
    if (v.t === "object") {
      const missing = (Array.isArray(s.required) ? s.required : []).filter(
        (k) => typeof k === "string" && !v.entries.some(([key]) => key === k),
      );
      if (missing.length > 0) errors.set(p, `Needs ${missing.join(", ")}.`);
      for (const [k, x] of v.entries) walk(x, schemaAt(found, pointer(p, k)), pointer(p, k));
    }
    if (v.t === "array") v.items.forEach((x, i) => walk(x, schemaAt(found, `${p}/${i}`), `${p}/${i}`));
  };
  walk(doc, schemaAt(found, ""), "");
  return errors;
}

/** Whether a typed number is a number JSON can hold. */
export const isJsonNumber = (text: string): boolean => NUMBER.test(text);

// ---- finding the schema ----

/** `a/b/../c` → `a/c`; undefined when the path climbs out of the repository. */
export function normalizePath(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.pop() === undefined) return undefined;
    } else out.push(part);
  }
  return out.length === 0 ? undefined : out.join("/");
}

/**
 * The classic wildcard walk: `many` matches any run of items, `one` any
 * single item. One restart point (the last `many`) makes it O(n·m) with no
 * backtracking blow-up, whatever the pattern.
 */
function wildcard<T>(pattern: readonly T[], subject: readonly T[], many: T, one: (p: T, s: T) => boolean): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < subject.length) {
    if (p < pattern.length && pattern[p] !== many && one(pattern[p]!, subject[s]!)) {
      p++;
      s++;
    } else if (p < pattern.length && pattern[p] === many) {
      star = p++;
      resume = s;
    } else if (star >= 0) {
      p = star + 1;
      s = ++resume;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === many) p++;
  return p === pattern.length;
}

/** One path segment against one glob segment: `*` any run, `?` one character. */
const segmentMatches = (glob: string, name: string): boolean =>
  wildcard([...glob.replace(/\*+/g, "*")], [...name], "*", (g, c) => g === "?" || g === c);

/**
 * A glob as a whole-path test, segment by segment: a `**` segment matches
 * any number of folders, `*` and `?` stay inside one. No regular expression
 * is built from a glob a repository wrote.
 */
export function globMatches(glob: string, path: string): boolean {
  const globParts = glob.replace(/^\/+/, "").split("/");
  const pathParts = path.replace(/^\/+/, "").split("/");
  return wildcard(globParts, pathParts, "**", segmentMatches);
}

const MAX_GLOBS = 200;
const MAX_GLOB = 200;

/** Where a schema for `path` might be, in the order they are tried. */
export async function findSchema(
  path: string,
  doc: Json,
  read: (path: string) => Promise<string | undefined>,
): Promise<FoundSchema | undefined> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const tryRead = async (candidate: string | undefined): Promise<FoundSchema | undefined> => {
    if (candidate === undefined || candidate === path) return undefined;
    const text = await read(candidate);
    const root = text === undefined ? undefined : parseSchema(text);
    return root === undefined ? undefined : { root, from: candidate };
  };

  const declared = doc.t === "object" ? getAt(doc, "/$schema") : undefined;
  if (declared?.t === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(declared.v)) {
    const found = await tryRead(
      normalizePath(declared.v.startsWith("/") ? declared.v : dir + declared.v),
    );
    if (found !== undefined) return found;
  }

  const name = path.slice(dir.length).replace(/\.(?:json|ya?ml|toml)$/i, "");
  const sibling = await tryRead(`${dir}${name}.schema.json`);
  if (sibling !== undefined) return sibling;

  const map = parseSchema((await read(".forge/schemas.json")) ?? "");
  if (map !== undefined) {
    // A bounded map of short globs, each matched in O(glob × path).
    for (const [glob, target] of Object.entries(map).slice(0, MAX_GLOBS)) {
      if (typeof target !== "string" || glob.length > MAX_GLOB || !globMatches(glob, path)) continue;
      const found = await tryRead(normalizePath(target));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Why a config file's new text breaks the schema it names, as one sentence, or
 * undefined when it keeps it (or is not a config file, or has no schema). The
 * terminal asks this before a commit, as the form does before a save.
 */
export async function schemaRefusal(
  path: string,
  text: string,
  read: (path: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (!isFormConfig(path)) return undefined;
  const parsed = parseConfig(path, text);
  if (!parsed.ok) return undefined;
  const found = await findSchema(path, parsed.value, read);
  const errors = [...validate(parsed.value, found)];
  if (errors.length === 0) return undefined;
  const [at, message] = errors[0]!;
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : "";
  return `${path} breaks ${found!.from}: ${at === "" ? "the top level" : at} ${message.charAt(0).toLowerCase()}${message.slice(1)}${more}`;
}
