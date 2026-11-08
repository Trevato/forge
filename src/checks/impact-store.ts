/**
 * The impact map kept beside the forge (#1794). A check's checkout is
 * thrown away when it ends, so a map the full gate measured there would
 * be lost with it. The forge keeps one map per repository under the data
 * directory: it seeds every check's checkout with it, and takes the map
 * back from a green run of the default branch (or the full gate on land).
 *
 * The check finds the file by `FORGE_CHECK_IMPACT`, a name relative to
 * its checkout. What comes back is repository code's output: it is
 * size-capped and parsed by `parseImpact` before it is kept.
 */

import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatImpact, parseImpact } from "./impact.ts";

/** Where in the checkout the map is handed over, both ways. */
export const IMPACT_FILE = ".forge-impact.json";

/** A map bigger than this is refused: 331 tests × ~100 files is ~1.5 MB. */
const MAX_BYTES = 8 * 1024 * 1024;

const storeOf = (dataDir: string, repoId: string): string =>
  join(dataDir, "checks", "impact", `${repoId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

/** The kept map, when there is a valid one. */
function readValid(path: string): Map<string, string[]> | undefined {
  try {
    if (statSync(path).size > MAX_BYTES) return undefined;
    const parsed = parseImpact(readFileSync(path, "utf8"));
    return parsed.ok && parsed.value.size > 0 ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

/** The repository's kept map, when there is a valid one. */
export const keptImpact = (dataDir: string, repoId: string): Map<string, string[]> | undefined =>
  readValid(storeOf(dataDir, repoId));

/** Copies the kept map into a checkout; how many tests it maps, or 0 for none. */
export function seedImpact(dataDir: string, repoId: string, checkout: string): number {
  const map = readValid(storeOf(dataDir, repoId));
  if (map === undefined) return 0;
  // The checkout is the repository's: whatever it put at this name (a
  // symlink out, say) goes, and the map is written as a new file.
  const path = join(checkout, IMPACT_FILE);
  rmSync(path, { force: true, recursive: true });
  writeFileSync(path, formatImpact(map), { flag: "wx" });
  return map.size;
}

/**
 * Keeps the map a green check left in its checkout. The answer is the line
 * for the check's log, or `undefined` when the check left none.
 */
export function keepImpact(dataDir: string, repoId: string, checkout: string): string | undefined {
  const path = join(checkout, IMPACT_FILE);
  let size: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return "impact map not kept: not a plain file";
    size = stat.size;
  } catch {
    return undefined;
  }
  if (size > MAX_BYTES) return `impact map not kept: ${size} bytes is over ${MAX_BYTES}`;
  const parsed = parseImpact(readFileSync(path, "utf8"));
  if (!parsed.ok) return `impact map not kept: ${parsed.error}`;
  if (parsed.value.size === 0) return "impact map not kept: it maps no tests";
  const store = storeOf(dataDir, repoId);
  mkdirSync(join(dataDir, "checks", "impact"), { recursive: true });
  // Whole or not at all: a fast check reading mid-write sees the old map.
  const partial = `${store}.${process.pid}.tmp`;
  writeFileSync(partial, formatImpact(parsed.value));
  renameSync(partial, store);
  return `impact map kept: ${parsed.value.size} tests`;
}
