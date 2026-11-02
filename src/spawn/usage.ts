/**
 * What a child forge uses against its size (#2933). A child in a cell of
 * its own is read off the cell's watch (`apps/contain.ts`) and its data
 * directory; a hosted child shares this forge's process, so it has no
 * figures of its own and reads "shared". Plain data in, plain data out.
 */

import { diskBytes, cellCounters } from "../apps/contain.ts";
import type { Child } from "../actions/spawn.ts";
import { SIZES, type Size, type SizeLimits } from "./sizes.ts";

export type ForgeUse =
  | { readonly kind: "shared" }
  /** In a cell that is not running now (it starts on the next request). */
  | { readonly kind: "idle"; readonly limits: SizeLimits }
  | {
      readonly kind: "cell";
      readonly limits: SizeLimits;
      readonly memoryMiB: number;
      /** Cores used lately; null until the watch has enough to say. */
      readonly cores: number | null;
      /** Null until the first disk reading lands (it is taken off the request) or when the directory is unknown. */
      readonly diskMiB: number | null;
    };

/** The disk walk is bounded, but not free: a reading is kept this long, and refreshed off the request. */
const DISK_FRESH_MS = 30_000;
const disks = new Map<string, { at: number; bytes: number }>();
const walking = new Set<string>();

/**
 * The last reading of a directory, or undefined before the first. A stale or
 * missing one is refreshed after the caller has answered (a timer, never in
 * the request), so a page reads memory and costs no walk.
 */
function diskOf(dir: string, now: number): number | undefined {
  // Forget readings nobody has asked for lately (a deleted forge's), so the map stays as big as the list.
  for (const [d, r] of disks) if (now - r.at > DISK_FRESH_MS * 10) disks.delete(d);
  const kept = disks.get(dir);
  if ((kept === undefined || now - kept.at >= DISK_FRESH_MS) && !walking.has(dir)) {
    walking.add(dir);
    setTimeout(() => {
      try {
        disks.set(dir, { at: Date.now(), bytes: diskBytes([dir]) });
      } finally {
        walking.delete(dir);
      }
    }, 0).unref();
  }
  return kept?.bytes;
}

/** One child's use; `dir` is where its data lives, `now` the clock. */
export function forgeUse(child: Child, dir?: string, now = Date.now()): ForgeUse {
  if (child.placement !== "cell") return { kind: "shared" };
  const limits = SIZES[child.size];
  const counter = cellCounters().find((c) => c.label === `forge:${child.name}`);
  if (counter === undefined) return { kind: "idle", limits };
  const disk = dir === undefined ? undefined : diskOf(dir, now);
  return {
    kind: "cell",
    limits,
    memoryMiB: Math.round(counter.memoryBytes / 1024 / 1024),
    cores: counter.cores == null ? null : Math.round(counter.cores * 100) / 100,
    diskMiB: disk === undefined ? null : Math.round(disk / 1024 / 1024),
  };
}

/** "512 MiB", "2 GiB": a size's figure the way a person says it. */
export function mibWords(mib: number): string {
  return mib >= 1024 ? `${Math.round((mib / 1024) * 10) / 10} GiB` : `${mib} MiB`;
}

/** The cell's reading as three short phrases (memory, CPU, disk); one "shared" for a hosted child. */
export function useWords(u: ForgeUse): { memory: string; cpu: string; disk: string } {
  if (u.kind === "shared") return { memory: "shared", cpu: "shared", disk: "shared" };
  const cores = (n: number) => `${n} ${n === 1 ? "core" : "cores"}`;
  if (u.kind === "idle")
    return { memory: "not running", cpu: "not running", disk: "not running" };
  return {
    memory: `${mibWords(u.memoryMiB)} of ${mibWords(u.limits.memoryMiB)}`,
    cpu: u.cores === null ? `of ${cores(u.limits.cpu)}` : `${u.cores} of ${cores(u.limits.cpu)}`,
    disk: u.diskMiB === null ? `measuring · ${mibWords(u.limits.diskMiB)}` : `${mibWords(u.diskMiB)} of ${mibWords(u.limits.diskMiB)}`,
  };
}

/** A size with what it holds: "medium · 2 GiB, 2 cores, 10 GiB". */
export function sizeWords(size: Size): string {
  const l = SIZES[size];
  return `${size} · ${mibWords(l.memoryMiB)}, ${l.cpu} ${l.cpu === 1 ? "core" : "cores"}, ${mibWords(l.diskMiB)}`;
}

/** One line for the terminal: size, then use ("shared", or memory, CPU and disk). */
export function useLine(size: Size, u: ForgeUse): string {
  const w = useWords(u);
  return u.kind === "shared" ? `${size} · shared` : `${sizeWords(size)} · memory ${w.memory} · cpu ${w.cpu} · disk ${w.disk}`;
}
