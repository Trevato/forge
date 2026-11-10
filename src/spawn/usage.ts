/**
 * What a child forge uses against its size (#2933). A child in a cell of
 * its own is read off the cell's watch (`apps/contain.ts`) and its data
 * directory; a hosted child shares this forge's process, so it has no
 * figures of its own and reads "shared". Plain data in, plain data out.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diskBytes, cellCounters } from "../apps/contain.ts";
import type { Child } from "../actions/spawn.ts";
import { isSize, SIZES, type Size, type SizeLimits } from "./sizes.ts";

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

// ---- a child reading itself (#10853) ----

/** The child's size, as its parent set it (`cellEnv`, `spawn/cell.ts`); unset on a forge that is no cell child. */
export const SIZE_ENV = "FORGE_CELL_SIZE";
/** The child's own cgroup directory, absolute, as its parent made it; unset where only the watch holds the caps. */
export const CGROUP_DIR_ENV = "FORGE_CELL_CGROUP_DIR";

/** A forge in a cell, reading its own use against its size. */
export interface SelfUse {
  readonly size: Size;
  readonly use: Extract<ForgeUse, { kind: "cell" }>;
  /** Where memory and CPU were read: the whole cell's cgroup, or this process alone (no cgroup to read). */
  readonly from: "cgroup" | "process";
}

/** What `selfUse` reads, injectable so a test hands it a cgroup of its own. */
export interface SelfSource {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dataDir: string;
  readonly now: number;
  /** When this process started, ms; the CPU before the first reading is averaged over it. */
  readonly startedAt: number;
  readonly read: (path: string) => string | undefined;
  /** This process's own figures, for a cell whose cgroup is not readable. */
  readonly rssBytes: () => number;
  readonly cpuUsec: () => number;
  /** The data directory's bytes, or undefined before the first reading (`diskOf`). */
  readonly disk: (dir: string, now: number) => number | undefined;
}

const readOr = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

export const realSelf = (dataDir: string, now = Date.now()): SelfSource => ({
  env: process.env,
  dataDir,
  now,
  startedAt: STARTED_AT,
  read: readOr,
  rssBytes: () => process.memoryUsage.rss(),
  cpuUsec: () => {
    const c = process.cpuUsage();
    return c.user + c.system;
  },
  disk: diskOf,
});

/** `memory.current`: one integer, bytes. */
export function parseMemoryCurrent(text: string | undefined): number | undefined {
  const n = text === undefined ? NaN : Number(text.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** `cpu.stat`'s `usage_usec`: user plus system CPU of every process in the cgroup, µs. */
export function parseUsageUsec(text: string | undefined): number | undefined {
  const m = text === undefined ? null : /^usage_usec (\d+)$/m.exec(text);
  const n = m === null ? NaN : Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * The last CPU reading and the cores it gave, kept in process memory (named
 * in AGENTS.md): cores are the CPU µs between two readings over the
 * wall-clock µs between them (cores = Δusage_usec / Δt_µs). A reading under
 * a second after the last gives the last figure again; the first gives the
 * average since the process started.
 */
let lastCpu: { at: number; usec: number; cores: number | null; from: "cgroup" | "process" } | undefined;
const CPU_MIN_SPAN_MS = 1000;

/** Forget the kept CPU reading; for tests. */
export function forgetSelfCpu(): void {
  lastCpu = undefined;
}

/** Cores from two cumulative readings `ms` apart, to two places; null over a span too short to say. */
export function coresBetween(usecBefore: number, usecAfter: number, ms: number): number | null {
  if (ms < CPU_MIN_SPAN_MS || usecAfter < usecBefore) return null;
  return Math.round(((usecAfter - usecBefore) / (ms * 1000)) * 100) / 100;
}

/** This forge's own use against its size, or null when it is no cell child (no size in its environment). */
export function selfUse(s: SelfSource): SelfUse | null {
  const raw = s.env[SIZE_ENV];
  if (!isSize(raw)) return null;
  const dir = s.env[CGROUP_DIR_ENV];
  const cg = dir === undefined || !dir.startsWith("/") ? undefined : dir;
  const mem = cg === undefined ? undefined : parseMemoryCurrent(s.read(join(cg, "memory.current")));
  const usage = cg === undefined ? undefined : parseUsageUsec(s.read(join(cg, "cpu.stat")));
  const from = mem !== undefined && usage !== undefined ? "cgroup" : "process";
  const memoryBytes = from === "cgroup" ? mem! : s.rssBytes();
  const usec = from === "cgroup" ? usage! : s.cpuUsec();
  let cores: number | null;
  if (lastCpu === undefined || lastCpu.from !== from || usec < lastCpu.usec) {
    // The cgroup was made as this process started, so its count runs from about then.
    cores = coresBetween(0, usec, s.now - s.startedAt);
    lastCpu = { at: s.now, usec, cores, from };
  } else if (s.now - lastCpu.at < CPU_MIN_SPAN_MS) {
    cores = lastCpu.cores;
  } else {
    cores = coresBetween(lastCpu.usec, usec, s.now - lastCpu.at);
    lastCpu = { at: s.now, usec, cores, from };
  }
  const disk = s.disk(s.dataDir, s.now);
  return {
    size: raw,
    from,
    use: {
      kind: "cell",
      limits: SIZES[raw],
      memoryMiB: Math.round(memoryBytes / 1024 / 1024),
      cores,
      diskMiB: disk === undefined ? null : Math.round(disk / 1024 / 1024),
    },
  };
}

/** One child as the parent's machines page lists it: its name, its size and its use against it. */
export interface ChildUseRow {
  readonly name: string;
  /** Where the child answers, for the row's link. */
  readonly url: string;
  readonly size: Size;
  readonly use: ForgeUse;
}

/** Every finished child's use against its size, by name; `dirOf` is where each one's data lives. */
export function childrenUse(children: readonly Child[], dirOf: (bodyId: string) => string, now = Date.now()): ChildUseRow[] {
  return children
    .filter((c) => c.done)
    .map((c) => ({ name: c.name, url: c.url, size: c.size, use: forgeUse(c, dirOf(c.bodyId), now) }));
}

/** The share of a limit used, percent, for a meter; 0 when unknown. */
export const shareOf = (used: number | null, limit: number): number => (used === null || limit <= 0 ? 0 : (used / limit) * 100);
