/**
 * What a sized forge's cores mean for its builds (#11694), said once for the
 * Settings row and the terminal screen. A child in a cell is held to its
 * size's cores one of three ways, and the words differ: the kernel's quota
 * (`cpu.max`), CPU affinity (`taskset`, `apps/contain.ts`), or only the watch
 * (`apps/cpu_rule.ts`). The child reads which from its own cgroup and its own
 * allowed CPUs; nothing here changes a limit.
 */

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { CPU_STOP_FACTOR, CPU_STOP_GRACE_MS, CPU_STOP_HOLD_MS } from "../apps/cpu_rule.ts";
import { CGROUP_DIR_ENV, SIZE_ENV } from "./usage.ts";
import { isSize, SIZES } from "./sizes.ts";

export type CoresHold = "quota" | "affinity" | "watch";

export interface Cores {
  readonly cpus: number;
  readonly hold: CoresHold;
}

export interface CoresSource {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly read: (path: string) => string | undefined;
  readonly machine: number;
}

/** `cpu.max` held to a number of cores: "200000 100000" is a quota, "max 100000" none. */
export const hasQuota = (cpuMax: string | undefined): boolean => /^\d+\s/.test(cpuMax?.trim() ?? "");

/** How many CPUs a `Cpus_allowed_list` ("0-3,8") names; undefined when unreadable. */
export function allowedCpus(status: string | undefined): number | undefined {
  const m = status === undefined ? null : /^Cpus_allowed_list:\s*(\S+)/m.exec(status);
  if (m === null) return undefined;
  let n = 0;
  for (const part of m[1]!.split(",")) {
    const r = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (r === null) return undefined;
    n += (r[2] === undefined ? 0 : Number(r[2]) - Number(r[1])) + 1;
  }
  return n;
}

const readOr = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

export const realCores = (): CoresSource => ({ env: process.env, read: readOr, machine: availableParallelism() });

/** This forge's cores and how they are held; null when it is no cell child (no size in its environment). */
export function coresOf(s: CoresSource = realCores()): Cores | null {
  const size = s.env[SIZE_ENV];
  if (!isSize(size)) return null;
  const cpus = SIZES[size].cpu;
  const dir = s.env[CGROUP_DIR_ENV];
  if (dir !== undefined && dir.startsWith("/") && hasQuota(s.read(join(dir, "cpu.max")))) return { cpus, hold: "quota" };
  const allowed = allowedCpus(s.read("/proc/self/status"));
  if (allowed !== undefined && allowed < s.machine && allowed <= cpus) return { cpus, hold: "affinity" };
  return { cpus, hold: "watch" };
}

const coreWord = (n: number): string => `${n} ${n === 1 ? "CPU" : "CPUs"}`;
const minutes = (ms: number): string => `${ms / 60_000} minutes`;

/** One sentence for the Settings row and the terminal: what the cores mean for a build. */
export function coresWords(c: Cores): string {
  const head = `${coreWord(c.cpus)}: builds run${c.cpus === 1 ? ", slower" : ""}.`;
  if (c.hold === "quota") return `${head} The kernel holds this forge to its cores, so a busy build is slowed, never stopped.`;
  if (c.hold === "affinity") return `${head} This forge is pinned to its cores, so a busy build is slowed, never stopped.`;
  return `${head} Nothing limits this forge to its cores. A build that stays above ${CPU_STOP_FACTOR === 2 ? "twice" : `${CPU_STOP_FACTOR}×`} its cores for ${minutes(CPU_STOP_HOLD_MS)} is stopped; the first ${minutes(CPU_STOP_GRACE_MS)} are safe.`;
}

/** The line, or undefined on a forge that is no cell child. */
export function coresLine(s: CoresSource = realCores()): string | undefined {
  const c = coresOf(s);
  return c === null ? undefined : coresWords(c);
}
