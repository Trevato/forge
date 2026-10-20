/**
 * Files that hold the forge's state must not be readable by anyone else on
 * the machine. The database and its write-ahead files are created 0600
 * (`db.ts`); one found wider at boot — a helper pod with fsGroup re-moded
 * the volume (#1436) — is said, never silently chmod-ed and never fatal:
 * production's files may have been 0644 for a long time.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

export const DB_FILES = ["forge.db", "forge.db-wal", "forge.db-shm"] as const;

/** One sentence per database file that group or world can read, naming the fix. */
export function openDbFiles(dataDir: string): { name: string; sentence: string }[] {
  const found: { name: string; sentence: string }[] = [];
  for (const name of DB_FILES) {
    const path = join(dataDir, name);
    let mode: number;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      continue; // absent: -wal and -shm come and go
    }
    if ((mode & 0o077) !== 0)
      found.push({
        name,
        sentence: `${path} is mode ${mode.toString(8)}; it should be 0600 — run chmod 600 ${path}`,
      });
  }
  return found;
}
