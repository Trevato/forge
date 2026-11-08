/**
 * The machine's history on disk (`machine_sample`): every 15-s point for a
 * day, and every 5-min point — the mean and the max of the 15-s points in
 * it — for 30 days. Each write rolls up the 5-min windows that have closed
 * and drops what has left its window, so the table never grows past
 * 24 h / 15 s + 30 d / 5 min = 5,760 + 8,640 rows per target.
 */
import type { Database } from "bun:sqlite";
import { withoutWaiting } from "../kernel/db.ts";
import { quietly } from "../core/write_clock.ts";

export const FINE_MS = 15_000;
export const COARSE_MS = 300_000;
export const FINE_KEEP_MS = 24 * 3_600_000;
export const COARSE_KEEP_MS = 30 * 24 * 3_600_000;

/** One target at one instant. A null is a series this machine cannot read. */
export type Point = {
  /** Epoch ms. */
  at: number;
  target: string;
  /** Cores in use, averaged since the sample before. */
  cpuCores: number | null;
  memoryBytes: number | null;
  /** The node's 1-min load average, runnable tasks; null for every other target. */
  load: number | null;
  /** °C, for a CPU or a sensor with a thermometer (`boards/thermal.ts`); absent for every other target. */
  celsius?: number;
  /** `forge` only: the event loop's p99 lateness over the step, ms (`kernel/loop_lag.ts`). */
  lagMs?: number;
  /** `forge` only: checks running at the instant. */
  checks?: number;
  /** `forge` only: crew runs running at the instant. */
  agents?: number;
};

/** One target over one 5-min window, `at` its start. */
export type Rolled = {
  at: number;
  target: string;
  cpuCores: number | null;
  cpuCoresMax: number | null;
  memoryBytes: number | null;
  memoryBytesMax: number | null;
  load: number | null;
  celsius: number | null;
  celsiusMax: number | null;
  lagMs: number | null;
  lagMsMax: number | null;
  checks: number | null;
  agents: number | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

function stats(values: (number | null)[]): { mean: number | null; max: number | null } {
  const xs = values.filter((v): v is number => v !== null);
  if (xs.length === 0) return { mean: null, max: null };
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, max: Math.max(...xs) };
}

/** The 5-min mean and max of `points`, per window and target, in window then target order. */
export function rollUp(points: readonly Point[]): Rolled[] {
  const groups = new Map<string, { at: number; target: string; ps: Point[] }>();
  for (const p of points) {
    const at = Math.floor(p.at / COARSE_MS) * COARSE_MS;
    const k = `${at}\u0000${p.target}`;
    const g = groups.get(k);
    if (g) g.ps.push(p);
    else groups.set(k, { at, target: p.target, ps: [p] });
  }
  return [...groups.values()]
    .sort((a, b) => a.at - b.at || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
    .map(({ at, target, ps }) => {
      const cpu = stats(ps.map((p) => p.cpuCores));
      const mem = stats(ps.map((p) => p.memoryBytes));
      const temp = stats(ps.map((p) => p.celsius ?? null));
      const lag = stats(ps.map((p) => p.lagMs ?? null));
      return {
        at, target,
        cpuCores: cpu.mean, cpuCoresMax: cpu.max,
        memoryBytes: mem.mean, memoryBytesMax: mem.max,
        load: stats(ps.map((p) => p.load)).mean,
        celsius: temp.mean, celsiusMax: temp.max,
        lagMs: lag.mean, lagMsMax: lag.max,
        checks: stats(ps.map((p) => p.checks ?? null)).mean,
        agents: stats(ps.map((p) => p.agents ?? null)).mean,
      };
    });
}

type FineRow = {
  at: string; target: string; cpu_cores: number | null; memory_bytes: number | null; load: number | null; celsius: number | null;
  lag_ms: number | null; checks: number | null; agents: number | null;
};

/**
 * Keep `points` (taken at `now`), roll up the windows that closed, drop what is past its window. One transaction,
 * never waiting on another process's write lock: behind one it throws at once and the sampler's next tick tries again (#6957).
 */
export function record(db: Database, points: readonly Point[], now: number): void {
  const put = db.query(
    `INSERT OR REPLACE INTO machine_sample
       (at, step, target, cpu_cores, cpu_cores_max, memory_bytes, memory_bytes_max, load, celsius, celsius_max,
        lag_ms, lag_ms_max, checks, agents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  withoutWaiting(db, db.transaction(() => quietly(db, () => {
    for (const p of points) {
      const c = p.celsius ?? null;
      const lag = p.lagMs ?? null;
      put.run(
        iso(p.at), 15, p.target, p.cpuCores, p.cpuCores, p.memoryBytes, p.memoryBytes, p.load, c, c,
        lag, lag, p.checks ?? null, p.agents ?? null,
      );
    }
    // Every window that ended by now and is not rolled yet: after the last rolled one.
    const last = db.query<{ at: string | null }, []>(
      "SELECT MAX(at) AS at FROM machine_sample WHERE step = 300",
    ).get()?.at;
    const from = last == null ? "" : iso(Date.parse(last) + COARSE_MS);
    const to = iso(Math.floor(now / COARSE_MS) * COARSE_MS);
    const fine = db.query<FineRow, [string, string]>(
      `SELECT at, target, cpu_cores, memory_bytes, load, celsius, lag_ms, checks, agents FROM machine_sample
        WHERE step = 15 AND at >= ? AND at < ?`,
    ).all(from, to);
    for (const r of rollUp(fine.map((f) => ({
      at: Date.parse(f.at), target: f.target, cpuCores: f.cpu_cores, memoryBytes: f.memory_bytes, load: f.load,
      ...(f.celsius === null ? {} : { celsius: f.celsius }),
      ...(f.lag_ms === null ? {} : { lagMs: f.lag_ms }),
      ...(f.checks === null ? {} : { checks: f.checks }),
      ...(f.agents === null ? {} : { agents: f.agents }),
    })))) {
      put.run(
        iso(r.at), 300, r.target, r.cpuCores, r.cpuCoresMax, r.memoryBytes, r.memoryBytesMax, r.load,
        r.celsius, r.celsiusMax, r.lagMs, r.lagMsMax, r.checks, r.agents,
      );
    }
    db.query("DELETE FROM machine_sample WHERE step = 15 AND at < ?").run(iso(now - FINE_KEEP_MS));
    db.query("DELETE FROM machine_sample WHERE step = 300 AND at < ?").run(iso(now - COARSE_KEEP_MS));
  })));
}
