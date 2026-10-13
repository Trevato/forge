/**
 * The tests a red full gate on land taught a pull (`landVerdict`), kept as
 * one small file per pull under the data directory. The pull's next fast
 * run is handed them as `FORGE_CHECK_LEARNED`, for `--learned`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Only a test file's path is kept: it ends up on a command line. */
const TEST_FILE = /^[A-Za-z0-9_./-]{1,200}\.test\.[cm]?[jt]sx?$/;

const fileOf = (dataDir: string, pullId: string): string =>
  join(dataDir, "checks", "learned", `${pullId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

export function readLearned(dataDir: string, pullId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileOf(dataDir, pullId), "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter((f): f is string => typeof f === "string" && TEST_FILE.test(f) && !f.includes(".."))
      : [];
  } catch {
    return [];
  }
}

export function addLearned(dataDir: string, pullId: string, files: readonly string[]): void {
  const all = [...new Set([...readLearned(dataDir, pullId), ...files])].filter(
    (f) => TEST_FILE.test(f) && !f.includes(".."),
  );
  if (all.length === 0) return;
  mkdirSync(join(dataDir, "checks", "learned"), { recursive: true });
  writeFileSync(fileOf(dataDir, pullId), JSON.stringify(all));
}
