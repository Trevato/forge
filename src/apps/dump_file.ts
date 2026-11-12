/**
 * A dump already in an app's data directory, for the terminal (#11697). A
 * terminal cannot paste 16 MB, and it must not read a path a person types,
 * so it reads one named file from `imports/` under the environment's data
 * directory: a plain name ending `.sql`, no separator, at most `DUMP_MAX` bytes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BODY_MAX } from "../http/limits.ts";

export const DUMP_MAX = BODY_MAX;
export const DUMP_FILE = /^[\w][\w.-]*\.sql$/;
export const IMPORTS_DIR = "imports";

export type DumpRead =
  | { readonly ok: true; readonly sql: string }
  | { readonly ok: false; readonly error: "invalid_name" | "missing" | "too_large" };

export function readStagedDump(envDir: string, name: string): DumpRead {
  if (!DUMP_FILE.test(name) || name.includes("..")) return { ok: false, error: "invalid_name" };
  const path = join(envDir, IMPORTS_DIR, name);
  if (!existsSync(path) || !statSync(path).isFile()) return { ok: false, error: "missing" };
  if (statSync(path).size > DUMP_MAX) return { ok: false, error: "too_large" };
  return { ok: true, sql: readFileSync(path, "utf8") };
}

export const DUMP_FILE_WORDS = {
  invalid_name: "A dump file is a name ending .sql: letters, digits, dots, dashes and underscores.",
  missing: `No such file in the app's ${IMPORTS_DIR}/ directory.`,
  too_large: "The dump is over 16 MB.",
} as const;
