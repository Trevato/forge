/**
 * Files that hold the forge's state must not be readable by anyone else on
 * the machine. The database and its write-ahead files are created 0600
 * (`db.ts`); one found wider at boot — a helper pod with fsGroup re-moded
 * the volume (#1436) — is tightened at boot and logged, never fatal and never
 * silent: production's files may have been 0644 for a long time, and SQLite
 * gives -wal and -shm the mode of the main file, so leaving it wide kept
 * the vitals degraded for good (#3084).
 */

import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLog } from "./log.ts";

const log = createLog("file_modes");

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

/**
 * Narrow every too-open database file to 0600 and say each one. A file that
 * cannot be changed (not ours) stays, and vitals keeps naming it.
 */
export function tightenDbFiles(dataDir: string): void {
  for (const { name } of openDbFiles(dataDir)) {
    const path = join(dataDir, name);
    try {
      chmodSync(path, 0o600);
      log.warn("database file was too open; set to 0600", { path });
    } catch {
      // Not ours to change: vitals still says it.
    }
  }
}
