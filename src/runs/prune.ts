/**
 * Run logs nothing reads any more (#6238). Every run writes `<id>.log` and
 * a check `<id>.vitals.json` under `runs/`, and nothing removed them, so the
 * state volume only grew. A file whose last write is older than `maxAgeMs`
 * is removed; the pages that link a log already say "no log" for a missing one.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { runsRoot } from "./log.ts";

/** Logs and vitals are kept this long after their last write. */
export const RUN_FILES_KEEP_MS = 14 * 86_400_000;

/** Remove the regular files of `runs/` last written before `now - maxAgeMs`; how many went. */
export function pruneRunFiles(
  dataDir: string,
  now: number = Date.now(),
  maxAgeMs: number = RUN_FILES_KEEP_MS,
): number {
  const root = runsRoot(dataDir);
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(root, name);
    try {
      const st = statSync(path);
      if (!st.isFile() || now - st.mtimeMs <= maxAgeMs) continue;
      rmSync(path, { force: true });
      removed++;
    } catch {
      // gone already, or busy: the next sweep looks again
    }
  }
  return removed;
}
