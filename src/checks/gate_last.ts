/**
 * What the last full gate said of each test file: `bun test` prints the file
 * as `test/x.test.ts:` before its results, `(pass) name` and `(fail) name`
 * under it. Kept as one small file under the data directory, replaced by
 * every gate, for the Resilience page to read.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FileResult = "pass" | "fail";

const HEADER = /^([A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?):$/;
const RESULT = /^\((pass|fail)\) /;

/** A file is red when any of its tests failed, green when it ran and none did. */
export function fileResults(lines: readonly string[]): Record<string, FileResult> {
  const out: Record<string, FileResult> = {};
  let file: string | undefined;
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) {
      file = header[1];
      if (file !== undefined && out[file] === undefined) out[file] = "pass";
      continue;
    }
    const result = RESULT.exec(line);
    if (result && file !== undefined && result[1] === "fail") out[file] = "fail";
  }
  return out;
}

const fileOf = (dataDir: string): string => join(dataDir, "checks", "gate-last.json");

export function keepGate(dataDir: string, lines: readonly string[]): void {
  const results = fileResults(lines);
  if (Object.keys(results).length === 0) return;
  mkdirSync(join(dataDir, "checks"), { recursive: true });
  writeFileSync(fileOf(dataDir), JSON.stringify(results));
}

/** Only the forge's own repository's gate is the record /resilience reads. */
export function keepForgeGate(
  dataDir: string,
  forgeRepo: string | undefined,
  repo: string,
  lines: readonly string[],
): void {
  if (forgeRepo === repo) keepGate(dataDir, lines);
}

export function readGate(dataDir: string): Record<string, FileResult> {
  const out: Record<string, FileResult> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileOf(dataDir), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [file, result] of Object.entries(parsed))
      if (result === "pass" || result === "fail") out[file] = result;
  } catch {
    // no gate has run yet
  }
  return out;
}
