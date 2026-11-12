/**
 * The volume under a directory, as statfs(2) reports it: free is `bavail`,
 * what an unprivileged writer can still use, total is `blocks`, both times
 * `bsize`. One reader every default reading goes through (vitals, the disk
 * floor of `spawn/disk_floor.ts`), so the suite can give it a disk.
 */

import { statfsSync } from "node:fs";

/** What a volume holds and has free. */
export interface DiskReading {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** The volume under `dir`, as the operating system reports it. */
export function statDisk(dir: string): DiskReading {
  const fs = statfsSync(dir);
  return {
    freeBytes: Number(fs.bavail) * Number(fs.bsize),
    totalBytes: Number(fs.blocks) * Number(fs.bsize),
  };
}

let reader: (dir: string) => DiskReading = statDisk;

/**
 * The suite runs on machines whose disks are whatever they are; its preload
 * gives a roomy one, so no test is refused by the machine it ran on, and a
 * test of a full disk gives its own. `undefined` puts statfs back.
 */
export function provideDiskForTest(r: ((dir: string) => DiskReading) | undefined): void {
  reader = r ?? statDisk;
}

/** The volume under `dir` as the forge reads it by default. */
export const readDisk = (dir: string): DiskReading => reader(dir);
