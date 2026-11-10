/**
 * What the machine is using, every 15 s, into the ring (`boards/ring.ts`),
 * for the `machine` source a board queries:
 *
 * - `forge`: the pod, from its cgroup v2 — `cpu.stat` `usage_usec` as a
 *   rate, and `memory.current` — and whether it still serves (#3319): its
 *   event loop's p99 lateness over the step (`kernel/loop_lag.ts`), beside
 *   the checks and crew runs running at the instant (`run` rows).
 * - `check:<run id>` and `app:<slug>/<env>`: each labelled cell, from the
 *   watch that holds it to its limits (`apps/contain.ts`). A container
 *   cannot make a cgroup per cell, so this is the cell's process tree read
 *   from `/proc`: user + system CPU as a rate, and resident memory.
 * - `node`: `/proc/stat` busy time as a rate, `MemTotal − MemAvailable`
 *   from `/proc/meminfo`, and the 1-min load from `/proc/loadavg`.
 * - `cpu:<n>` (n zero-padded to three digits, so they sort): each logical
 *   CPU's `cpu<n>` line of `/proc/stat` as a rate — at most 1 core — and
 *   its core's temperature in °C (`boards/thermal.ts`).
 * - `package:<P>` and `sensor:<chip>/<label>`: every other thermometer
 *   under `/sys/class/hwmon`, °C only.
 *
 * A file that is missing or unreadable (not Linux, no cgroup v2) leaves its
 * series null — never a guess — and `gaps` names it for the page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { cellCounters, type CellCounter } from "../apps/contain.ts";
import { startLoopLag, type LoopLag } from "../kernel/loop_lag.ts";
import { FINE_MS, record, type Point } from "./ring.ts";
import { readHwmon, readTopology, temperatures } from "./thermal.ts";
import { during } from "../perf/jobs.ts";

export type Paths = { cgroup: string; proc: string; sys: string };
export const SYSTEM: Paths = { cgroup: "/sys/fs/cgroup", proc: "/proc", sys: "/sys" };

/** `/proc/stat` counts in USER_HZ, 100 a second on every Linux the forge runs on. */
const USER_HZ = 100;

/** Cumulative counters at one instant; a rate needs two of them. */
export type Counters = {
  /** Epoch ms. */
  at: number;
  forge: { cpuUsec: number | null; memoryBytes: number | null };
  node: { cpuUsec: number | null; memoryBytes: number | null; load: number | null };
  cells: readonly CellCounter[];
  /** Each logical CPU: busy µs since boot, and its core's °C when a thermometer maps to it. */
  cpus: readonly { id: number; busyUsec: number; celsius: number | null }[];
  /** Every thermometer no CPU took, °C. */
  sensors: readonly { target: string; celsius: number }[];
};

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const finite = (n: number) => (Number.isFinite(n) && n >= 0 ? n : null);

/** `usage_usec` from a cgroup v2 `cpu.stat`, µs of CPU since the cgroup began. */
export function parseCpuStat(text: string | null): number | null {
  const m = text === null ? null : /^usage_usec (\d+)$/m.exec(text);
  return m ? finite(Number(m[1])) : null;
}

/** Busy µs from one `/proc/stat` line's tick fields: user nice system irq softirq steal (guest is inside user). */
function busyUsec(fields: string): number | null {
  const f = fields.trim().split(/\s+/).map(Number);
  if (f.length < 4 || f.some((n) => !Number.isFinite(n))) return null;
  const busy = f[0]! + f[1]! + f[2]! + (f[5] ?? 0) + (f[6] ?? 0) + (f[7] ?? 0);
  return (busy * 1_000_000) / USER_HZ;
}

/** Busy CPU time of the whole node from `/proc/stat`'s `cpu` line, µs. */
export function parseProcStat(text: string | null): number | null {
  const m = text === null ? null : /^cpu +(.*)$/m.exec(text);
  return m ? busyUsec(m[1]!) : null;
}

/** Busy time of each logical CPU from `/proc/stat`'s `cpu<n>` lines, µs, in CPU order. */
export function parseProcStatCpus(text: string | null): { id: number; busyUsec: number }[] {
  const out: { id: number; busyUsec: number }[] = [];
  for (const m of text?.matchAll(/^cpu(\d+) +(.*)$/gm) ?? []) {
    const busy = busyUsec(m[2]!);
    if (busy !== null) out.push({ id: Number(m[1]), busyUsec: busy });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** A logical CPU's target: `cpu:` and its number, zero-padded to three digits so a board lists them in order. */
export const cpuTarget = (id: number) => `cpu:${String(id).padStart(3, "0")}`;

/** Memory in use on the node, bytes: `MemTotal − MemAvailable` (kB × 1024). */
export function parseMeminfo(text: string | null): number | null {
  if (text === null) return null;
  const total = /^MemTotal:\s+(\d+) kB$/m.exec(text);
  const avail = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
  return total && avail ? finite((Number(total[1]) - Number(avail[1])) * 1024) : null;
}

/** The 1-min load average: the first field of `/proc/loadavg`. */
export function parseLoadavg(text: string | null): number | null {
  const first = text?.trim().split(/\s+/)[0];
  return first === undefined || first === "" ? null : finite(Number(first));
}

/** Read every counter now. */
export function readCounters(paths: Paths, cells: readonly CellCounter[], at: number): Counters {
  const mem = read(join(paths.cgroup, "memory.current"));
  const stat = read(join(paths.proc, "stat"));
  const perCpu = parseProcStatCpus(stat);
  const temps = temperatures(readHwmon(paths.sys), readTopology(paths.sys, perCpu.map((c) => c.id)));
  return {
    at,
    forge: {
      cpuUsec: parseCpuStat(read(join(paths.cgroup, "cpu.stat"))),
      memoryBytes: mem === null || !/^\d+\s*$/.test(mem) ? null : Number(mem),
    },
    node: {
      cpuUsec: parseProcStat(stat),
      memoryBytes: parseMeminfo(read(join(paths.proc, "meminfo"))),
      load: parseLoadavg(read(join(paths.proc, "loadavg"))),
    },
    cells,
    cpus: perCpu.map((c) => ({ ...c, celsius: temps.perCpu.get(c.id) ?? null })),
    sensors: temps.sensors,
  };
}

/** Cores between two readings of one counter: Δµs / 10⁶ / Δs. Null without both, or when the counter went back. */
function cores(a: number | null | undefined, b: number | null | undefined, seconds: number): number | null {
  if (a == null || b == null || seconds <= 0 || b < a) return null;
  return (b - a) / 1_000_000 / seconds;
}

/** What the forge's own serving looked like over one step, for its `forge` point. */
export type Serving = { lagMs: number | null; checks: number | null; agents: number | null };

/** Checks and crew runs running now: the children that compete with the forge for its CPU. */
export function runningChildren(db: App["db"]): { checks: number; agents: number } {
  const rows = db.query<{ kind: string; n: number }, []>(
    "SELECT kind, COUNT(*) AS n FROM run WHERE state = 'running' AND kind IN ('check', 'agent') GROUP BY kind",
  ).all();
  const n = (kind: string) => rows.find((r) => r.kind === kind)?.n ?? 0;
  return { checks: n("check"), agents: n("agent") };
}

/**
 * The points between two readings. Without a reading before, CPU is null
 * (a rate needs two). A target with nothing readable has no point at all.
 * A label's cells are summed; a cell new since `prev` adds its memory but
 * not yet its CPU.
 */
export function pointsOf(prev: Counters | undefined, next: Counters, serving?: Serving): Point[] {
  const seconds = prev === undefined ? 0 : (next.at - prev.at) / 1000;
  const out: Point[] = [];
  const push = (p: Point) => {
    if (p.cpuCores !== null || p.memoryBytes !== null || p.load !== null || p.celsius != null || p.lagMs != null)
      out.push(p);
  };
  const forge: Point = {
    at: next.at, target: "forge",
    cpuCores: cores(prev?.forge.cpuUsec, next.forge.cpuUsec, seconds),
    memoryBytes: next.forge.memoryBytes, load: null,
  };
  if (serving?.lagMs != null) forge.lagMs = serving.lagMs;
  if (serving?.checks != null) forge.checks = serving.checks;
  if (serving?.agents != null) forge.agents = serving.agents;
  push(forge);
  const before = new Map((prev?.cells ?? []).map((c) => [c.key, c]));
  const byLabel = new Map<string, Point>();
  for (const c of next.cells) {
    const p = byLabel.get(c.label) ?? { at: next.at, target: c.label, cpuCores: null, memoryBytes: 0, load: null };
    const rate = cores(before.get(c.key)?.cpuUsec, c.cpuUsec, seconds);
    if (rate !== null) p.cpuCores = (p.cpuCores ?? 0) + rate;
    p.memoryBytes = (p.memoryBytes ?? 0) + c.memoryBytes;
    byLabel.set(c.label, p);
  }
  for (const p of [...byLabel.values()].sort((a, b) => (a.target < b.target ? -1 : 1))) push(p);
  push({
    at: next.at, target: "node",
    cpuCores: cores(prev?.node.cpuUsec, next.node.cpuUsec, seconds),
    memoryBytes: next.node.memoryBytes, load: next.node.load,
  });
  const busyBefore = new Map((prev?.cpus ?? []).map((c) => [c.id, c.busyUsec]));
  for (const c of next.cpus) {
    const p: Point = {
      at: next.at, target: cpuTarget(c.id),
      cpuCores: cores(busyBefore.get(c.id), c.busyUsec, seconds), memoryBytes: null, load: null,
    };
    if (c.celsius !== null) p.celsius = c.celsius;
    push(p);
  }
  for (const s of next.sensors) {
    push({ at: next.at, target: s.target, cpuCores: null, memoryBytes: null, load: null, celsius: s.celsius });
  }
  return out;
}

/** The series this machine cannot read, each with the file that would have said it. */
export function gaps(paths: Paths): string[] {
  const out: string[] = [];
  const missing = (file: string) => read(file) === null;
  const say = (series: string, file: string) => `${series}: ${file} is not readable here`;
  if (missing(join(paths.cgroup, "cpu.stat"))) out.push(say("forge cpu_cores", join(paths.cgroup, "cpu.stat")));
  if (missing(join(paths.cgroup, "memory.current"))) out.push(say("forge memory_bytes", join(paths.cgroup, "memory.current")));
  if (missing(join(paths.proc, "stat"))) out.push(say("node cpu_cores", join(paths.proc, "stat")));
  if (missing(join(paths.proc, "meminfo"))) out.push(say("node memory_bytes", join(paths.proc, "meminfo")));
  if (missing(join(paths.proc, "loadavg"))) out.push(say("node load", join(paths.proc, "loadavg")));
  const cpus = parseProcStatCpus(read(join(paths.proc, "stat"))).map((c) => c.id);
  if (cpus.length === 0) out.push(`cpu:<n> cpu_cores: ${join(paths.proc, "stat")} has no per-CPU lines here`);
  const hwmon = join(paths.sys, "class", "hwmon");
  const temps = temperatures(readHwmon(paths.sys), readTopology(paths.sys, cpus));
  if (temps.perCpu.size === 0 && temps.sensors.length === 0) {
    out.push(`celsius: ${hwmon} has no readable temperature here`);
  } else if (cpus.length > 0 && temps.perCpu.size === 0) {
    out.push(`cpu:<n> celsius: no coretemp chip under ${hwmon} maps a temperature to each core here`);
  }
  return out;
}

export type Sampler = { tick(now?: number): void; stop(): void };

/** Sample every 15 s into `app.db` until stopped. A failed tick is logged and the next one tries again. */
export function startSampler(
  app: App,
  options: { paths?: Paths; cells?: () => readonly CellCounter[]; everyMs?: number; lag?: LoopLag } = {},
): Sampler {
  const paths = options.paths ?? SYSTEM;
  const cells = options.cells ?? cellCounters;
  const lag = options.lag ?? startLoopLag();
  let prev: Counters | undefined;
  const tick = (now = Date.now()) => {
    try {
      const next = readCounters(paths, cells(), now);
      record(app.db, pointsOf(prev, next, { lagMs: lag.take(), ...runningChildren(app.db) }), now);
      prev = next;
    } catch (error) {
      app.log.warn("machine sample failed", { error: String(error) });
    }
  };
  during("sampler", tick);
  const timer = setInterval(() => during("sampler", tick), options.everyMs ?? FINE_MS);
  timer.unref?.();
  return {
    tick,
    stop: () => {
      clearInterval(timer);
      lag.stop();
    },
  };
}
