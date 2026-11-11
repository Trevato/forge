/**
 * What a variant carries on its branch: `variant.json`, at the root.
 *
 *   { "values": { "PRINT": "true" } }
 *
 * `values` are plain settings the process starts with, over the app's own
 * defaults. They are in git, so they are versioned and visible: a secret
 * never goes here (it is set forge-side, `core/app_env.ts`). Pure: parsing,
 * checking and writing the text, and reading the one-line output an app
 * leaves for the board. Fail closed: a file that is present and wrong is
 * refused with the field named, and the variant then starts with no values.
 */

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isAppEnvName, isReservedAppEnvName } from "../core/app_env.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const VARIANT_FILE = "variant.json";
export const VALUES_MAX = 20;
export const VALUE_LENGTH_MAX = 200;
export const VARIANT_FILE_BYTES_MAX = 16 * 1024;

/** Printable, one line. */
const PRINTABLE = /^[^\p{C}\p{Zl}\p{Zp}]*$/u;

/** One value, checked: the reason when it is not allowed. */
export function checkValue(name: string, value: unknown): string | undefined {
  if (!isAppEnvName(name)) return `${JSON.stringify(name.slice(0, 40))} is not a variable name (capitals, digits, underscore)`;
  if (isReservedAppEnvName(name)) return `${name} is set by the forge and cannot be a variant's value`;
  if (typeof value !== "string") return `${name} must be a string`;
  if ([...value].length > VALUE_LENGTH_MAX) return `${name} is over ${VALUE_LENGTH_MAX} characters`;
  if (!PRINTABLE.test(value)) return `${name} must be one printable line`;
  return undefined;
}

export function parseVariantFile(text: string): Result<Record<string, string>, string> {
  if (Buffer.byteLength(text, "utf8") > VARIANT_FILE_BYTES_MAX) return err(`${VARIANT_FILE} is over ${VARIANT_FILE_BYTES_MAX} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(`${VARIANT_FILE} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return err(`${VARIANT_FILE} is not an object`);
  const record = parsed as Record<string, unknown>;
  const extra = Object.keys(record).find((k) => k !== "values");
  if (extra !== undefined) return err(`unexpected field ${JSON.stringify(extra.slice(0, 40))}`);
  const values = record["values"] ?? {};
  if (typeof values !== "object" || values === null || Array.isArray(values)) return err("values is not an object");
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length > VALUES_MAX) return err(`values has more than ${VALUES_MAX} entries`);
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    const bad = checkValue(name, value);
    if (bad !== undefined) return err(bad);
    out[name] = value as string;
  }
  return ok(out);
}

/** The file's text for `values`: sorted, so the same values are the same bytes. */
export function variantFileText(values: Readonly<Record<string, string>>): string {
  const sorted: Record<string, string> = {};
  for (const name of Object.keys(values).sort()) sorted[name] = values[name]!;
  return `${JSON.stringify({ values: sorted }, null, 2)}\n`;
}

/** The values in a checkout's `variant.json`; none when absent or wrong. */
export function readVariantValues(dir: string): Record<string, string> {
  const path = join(dir, VARIANT_FILE);
  try {
    // A branch may commit a symlink: only a regular file is read, never what a link points at.
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info === undefined || !info.isFile() || info.size > VARIANT_FILE_BYTES_MAX) return {};
    const parsed = parseVariantFile(readFileSync(path, "utf8"));
    return parsed.ok ? parsed.value : {};
  } catch {
    return {};
  }
}

/** Parse "name=value" lines, one per line: the form a person types. Blank lines are skipped. */
export function parseValueLines(text: string): Result<Record<string, string>, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const at = line.indexOf("=");
    if (at < 1) return err(`"${line.slice(0, 40)}" is not NAME=value`);
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    const bad = checkValue(name, value);
    if (bad !== undefined) return err(bad);
    out[name] = value;
  }
  if (Object.keys(out).length > VALUES_MAX) return err(`more than ${VALUES_MAX} values`);
  return ok(out);
}

/** The line an app leaves in its data directory, `last-output.json`, for the board. */
export const OUTPUT_FILE = "last-output.json";

export interface LastOutput {
  readonly title: string;
  /** A path on the app's own address, or empty. */
  readonly path: string;
}

/**
 * `{ "title": "Edition 12", "path": "/editions/12" }` in the environment's data
 * directory: what this variant last made. Read as data only, bounded and
 * checked; a missing or wrong file is no output.
 */
export function readLastOutput(dataDir: string): LastOutput | undefined {
  const path = join(dataDir, OUTPUT_FILE);
  try {
    if (!existsSync(path) || statSync(path).size > 4096) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { title, path: href } = parsed as Record<string, unknown>;
    if (typeof title !== "string" || title === "" || [...title].length > 120 || !PRINTABLE.test(title)) return undefined;
    const to = typeof href === "string" ? href : "";
    if (to !== "" && (!to.startsWith("/") || to.startsWith("//") || to.length > 200 || !PRINTABLE.test(to) || /[\s"'<>\\]/.test(to))) return undefined;
    return { title, path: to };
  } catch {
    return undefined;
  }
}
