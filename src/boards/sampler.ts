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
import { join } from "node:path";
import type { App } from "../app.ts";
import { cellCounters, type CellCounter } from "../apps/contain.ts";
import { startLoopLag, type LoopLag } from "../kernel/loop_lag.ts";
import { cpuTarget, readCpus, readPoint, unreadable } from "./machine.ts";
import { FINE_MS, record, type Point } from "./ring.ts";
import { readHwmon, readTopology, temperatures } from "./thermal.ts";
import { during } from "../perf/jobs.ts";
import { withoutWaiting } from "../kernel/db.ts";
import { pruneEvents, TICK_ROWS } from "../system/retention_events.ts";

export type Paths = { cgroup: string; proc: string; sys: string };
export const SYSTEM: Paths = { cgroup: "/sys/fs/cgroup", proc: "/proc", sys: "/sys" };

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

/** Read every counter now. */
export function readCounters(paths: Paths, cells: readonly CellCounter[], at: number): Counters {
  const machine = readPoint(paths.cgroup, paths.proc);
  const { nodeUsec, cpus: perCpu } = readCpus(paths.proc);
  const temps = temperatures(readHwmon(paths.sys), readTopology(paths.sys, perCpu.map((c) => c.id)));
  return {
    at,
    forge: { cpuUsec: machine.cpuUsec, memoryBytes: machine.memoryBytes },
    node: { cpuUsec: nodeUsec, memoryBytes: machine.nodeMemoryBytes, load: machine.load },
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
  const out = unreadable(paths.cgroup, paths.proc);
  const { cpus: found } = readCpus(paths.proc);
  const cpus = found.map((c) => c.id);
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

/** `gaps` is what this sampler cannot read, said once at start and kept here for whoever asks. */
export type Sampler = { tick(now?: number): void; stop(): void; gaps: readonly string[] };

/** Sample every 15 s into `app.db` until stopped. A failed tick is logged and the next one tries again. */
export function startSampler(
  app: App,
  options: { paths?: Paths; cells?: () => readonly CellCounter[]; everyMs?: number; lag?: LoopLag } = {},
): Sampler {
  const paths = options.paths ?? SYSTEM;
  const cells = options.cells ?? cellCounters;
  const lag = options.lag ?? startLoopLag();
  let prev: Counters | undefined;
  const missing = gaps(paths);
  if (missing.length > 0) app.log.info("machine series unreadable here", { gaps: missing.join("; ") });
  const tick = (now = Date.now()) => {
    try {
      const next = readCounters(paths, cells(), now);
      record(app.db, pointsOf(prev, next, { lagMs: lag.take(), ...runningChildren(app.db) }), now);
      prev = next;
    } catch (error) {
      app.log.warn("machine sample failed", { error: String(error) });
    }
    // The same tick prunes one batch of old events (`system/retention_events.ts`); a busy
    // database skips it, and the next tick tries again.
    try {
      withoutWaiting(app.db, () => pruneEvents(app.db, now, TICK_ROWS));
    } catch (error) {
      app.log.warn("event prune failed", { error: String(error) });
    }
  };
  during("sampler", tick);
  const timer = setInterval(() => during("sampler", tick), options.everyMs ?? FINE_MS);
  timer.unref?.();
  return {
    tick,
    gaps: missing,
    stop: () => {
      clearInterval(timer);
      lag.stop();
    },
  };
}
