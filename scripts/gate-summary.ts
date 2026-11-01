/**
 * The one block a timed full gate ends its log with (#2065): how many
 * shards and why, the wall time, the cell's peak memory, the ten slowest
 * files, and a warning line for every file over {@link SLOW_SECONDS}.
 *
 * Plain data in, lines out. `scripts/test-shards.ts` gathers the numbers;
 * the cgroup is read through a function handed in, so a test can say what
 * the files hold, or that there are none. Nothing here changes the exit
 * code: a slow file is a warning, not a red.
 */

import { GATE_SUMMARY_HEADING } from "../src/checks/summary.ts";

/** A file over this many seconds is named on its own warning line. */
export const SLOW_SECONDS = 45;
/** How many of the slowest files the block lists. */
export const SLOWEST = 10;

const GIB = 1024 ** 3;
/** cgroup v1 writes "no limit" as a page-rounded 2^63 − 1; anything this big is none. */
const V1_UNLIMITED = 2 ** 60;

/** Where a memory number came from: a cgroup file, by name. */
export type Memory = { bytes: number; from: string } | undefined;

export type CgroupMemory = { limit: Memory; peak: Memory };

/** Reads one file, or undefined when it is not there. */
export type Reader = (path: string) => string | undefined;

/** A whole number of bytes, or undefined: "max", v1's "unlimited", blanks and junk are no number. */
function bytesIn(text: string | undefined): number | undefined {
  const trimmed = text?.trim();
  if (trimmed === undefined || !/^[0-9]{1,20}$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n < V1_UNLIMITED ? n : undefined;
}

/**
 * The cell's memory limit and peak, cgroup v2 first, then v1:
 * `memory.max` / `memory.limit_in_bytes`, and `memory.peak` /
 * `memory.max_usage_in_bytes`. A file that is missing, says "max", or
 * holds v1's "unlimited" is no number, never a made-up one.
 */
export function cgroupMemory(read: Reader): CgroupMemory {
  const first = (paths: readonly string[]): Memory => {
    for (const path of paths) {
      const bytes = bytesIn(read(path));
      if (bytes !== undefined)
        return { bytes, from: path.slice(path.lastIndexOf("/") + 1) };
    }
    return undefined;
  };
  return {
    limit: first(["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]),
    peak: first(["/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"]),
  };
}

export type GateSummary = {
  /** Shards the gate ran at once. */
  shards: number;
  /** `os.availableParallelism()`. */
  cpus: number;
  /** Most shards whatever the host (`SHARDS_MAX` in scripts/shards.ts). */
  shardsMax: number;
  /** Files the gate named. */
  files: number;
  /** `FORGE_CHECK_SHARDS` as it was set, if it was. */
  override: string | undefined;
  /** The memory `shardCount` was handed: the least of the machine's, the cgroup's and the cell's. */
  memoryBytes: number;
  /** Room one worker is given (`WORKER_MEMORY_BYTES` in scripts/shards.ts). */
  workerBytes: number;
  memory: CgroupMemory;
  /** Spawn of the first file to exit of the last, in seconds. */
  wallSeconds: number;
  /** Every file that ran, alone in its own `bun test`, and how long it took. */
  times: readonly { file: string; seconds: number }[];
};

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(2)} GiB`;

/**
 * Why the gate ran `shards` at once: the bounds `shardCount` took the least
 * of, and, when memory held it under one per CPU, that it did.
 */
function why(s: GateSummary): string {
  const set = s.override !== undefined && s.override.trim() !== "";
  const byMemory = Math.floor(s.memoryBytes / s.workerBytes);
  const room =
    `${gib(s.memoryBytes)}${s.memory.limit ? ` (cgroup ${s.memory.limit.from})` : " (no cgroup limit)"} ` +
    `at ${(s.workerBytes / 1024 ** 2).toFixed(0)} MiB each`;
  const bounds = set
    ? [`FORGE_CHECK_SHARDS ${s.override!.trim()}`, `${s.files} files`]
    : [`${s.cpus} CPUs`, `${byMemory} by memory, ${room}`, `SHARDS_MAX ${s.shardsMax}`, `${s.files} files`];
  const held = !set && s.shards < s.cpus && s.shards === byMemory && byMemory < Math.min(s.shardsMax, s.files);
  return `${s.shards} = least of ${bounds.join("; ")}${held ? " — fewer than the CPUs because of memory" : ""}`;
}

/** The block, one line each, every line but the file list starting `test-shards:`. */
export function summaryLines(s: GateSummary): string[] {
  const slowest = [...s.times]
    .sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const peak = s.memory.peak
    ? `${gib(s.memory.peak.bytes)}${s.memory.limit ? ` of ${gib(s.memory.limit.bytes)}` : ""} (${s.memory.peak.from})`
    : "unknown here";
  const top = slowest.slice(0, SLOWEST);
  return [
    GATE_SUMMARY_HEADING,
    `test-shards: shards: ${why(s)}`,
    `test-shards: wall: ${s.wallSeconds.toFixed(1)}s`,
    `test-shards: peak memory: ${peak}`,
    `test-shards: slowest ${top.length} of ${s.times.length} files:`,
    ...top.map((t) => `  ${t.seconds.toFixed(1).padStart(6)}s ${t.file}`),
    ...slowest
      .filter((t) => t.seconds > SLOW_SECONDS)
      .map((t) => `test-shards: over ${SLOW_SECONDS} s: ${t.file} (${t.seconds.toFixed(1)}s)`),
  ];
}
