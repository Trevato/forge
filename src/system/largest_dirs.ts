/**
 * The five largest directories under the forge's data (#11800): each
 * directory directly under `FORGE_DATA`, sized as `du -x` would (allocated
 * blocks, symlinks not followed, other volumes not entered). The walk is
 * asynchronous, so it never holds the event loop; one reading is shared by
 * /system and the MCP `system` tool, measured at most once a minute, and
 * no request waits on it longer than 0.8 s.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** One directory under the forge's data and what it holds on disk. */
export interface DirSize {
  readonly name: string;
  readonly bytes: number;
}

/** What one measurement found. */
export interface LargestDirs {
  /** When the measurement finished, ISO. */
  readonly at: string;
  readonly dirs: readonly DirSize[];
}

/** How many directories /system names. */
export const LARGEST_DIRS = 5;

/** The `n` largest, largest first; equal sizes by name, so the order is stable. */
export function largest(sizes: readonly DirSize[], n = LARGEST_DIRS): DirSize[] {
  return [...sizes].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).slice(0, n);
}

/** Bytes a file or directory entry takes on disk: its blocks where the system reports them. */
const onDisk = (s: { blocks: number; size: number }): number =>
  Number.isFinite(s.blocks) && s.blocks > 0 ? s.blocks * 512 : s.size;

/** Everything under `path` on the device `dev`, in bytes; what cannot be read counts as nothing. */
async function sizeOf(path: string, dev: number): Promise<number> {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const s = await lstat(full);
        if (s.dev !== dev) continue;
        total += onDisk(s);
        if (s.isDirectory()) stack.push(full);
      } catch {
        // Gone between the listing and the stat, or not ours to read.
      }
    }
  }
  return total;
}

/** Measures each directory directly under `dataDir` and keeps the five largest. */
export async function measureLargestDirs(dataDir: string, clock: () => number = Date.now): Promise<LargestDirs> {
  const root = await lstat(dataDir);
  const sizes: DirSize[] = [];
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dataDir, entry.name);
    try {
      const s = await lstat(full);
      if (s.dev !== root.dev) continue;
      sizes.push({ name: entry.name, bytes: onDisk(s) + (await sizeOf(full, root.dev)) });
    } catch {
      // A directory removed mid-walk is not one of the largest.
    }
  }
  return { at: new Date(clock()).toISOString(), dirs: largest(sizes) };
}

const FRESH_MS = 60_000;
const WAIT_MS = 800;

/** The last measurement, shared by /system and the MCP `system` tool; one per process, gone on restart. */
export function largestDirsCache(
  measure: (dataDir: string) => Promise<LargestDirs> = (d) => measureLargestDirs(d),
  clock: () => number = Date.now,
) {
  let last: { at: number; dataDir: string; value: LargestDirs } | null = null;
  // A walk that failed waits a minute too, so a missing directory costs one try a minute.
  let triedAt: number | null = null;
  let pending: Promise<LargestDirs | null> | null = null;
  const due = (dataDir: string): boolean =>
    pending === null &&
    (last === null || last.dataDir !== dataDir || clock() - last.at > FRESH_MS) &&
    (triedAt === null || clock() - triedAt > FRESH_MS || last?.dataDir !== dataDir);
  const refresh = (dataDir: string): Promise<LargestDirs | null> => {
    triedAt = clock();
    pending = measure(dataDir)
      .then((value) => {
        last = { at: clock(), dataDir, value };
        return value;
      })
      .catch(() => null)
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  const current = (dataDir: string): LargestDirs | null => (last?.dataDir === dataDir ? last.value : null);
  return {
    /** The last measurement, a new one started behind it when it is over a minute old; null before the first. */
    peek(dataDir: string): LargestDirs | null {
      if (due(dataDir)) void refresh(dataDir);
      return current(dataDir);
    },
    /** A measurement no more than a minute old when one finishes within `waitMs`, else the last one, else null. */
    async read(dataDir: string, waitMs = WAIT_MS): Promise<LargestDirs | null> {
      const running = due(dataDir) ? refresh(dataDir) : pending;
      if (running === null) return current(dataDir);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<null>((r) => {
        deadline = setTimeout(() => r(null), waitMs);
      });
      try {
        return (await Promise.race([running, timer])) ?? current(dataDir);
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

export const largestDirs = largestDirsCache();
