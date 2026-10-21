/**
 * A temporary directory on the checkout's own disk, for a suite whose data
 * would crowd `/tmp`. A check cell's `/tmp` is a 256 MiB tmpfs
 * (`TMP_MIB` in src/apps/contain.ts) shared by every file the gate runs at
 * once and by their coverage; a suite that writes tens of MB there fills it
 * as its neighbours start, and they fail in setup with no test named (#3693).
 * The checkout is on the cell's disk. `/.test-scratch/` is ignored by git.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

export const SCRATCH_ROOT = join(import.meta.dir, "..", "..", ".test-scratch");

/** A fresh directory under {@link SCRATCH_ROOT}; the suite removes it. */
export function scratchDir(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, prefix));
}
