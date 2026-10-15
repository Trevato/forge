/**
 * The machine's history on disk (`machine_sample`): every 15-s point for a
 * day, and every 5-min point — the mean and the max of the 15-s points in
 * it — for 30 days. Each write rolls up the 5-min windows that have closed
 * and drops what has left its window, so the table never grows past
 * 24 h / 15 s + 30 d / 5 min = 5,760 + 8,640 rows per target.
 */
import type { Database } from "bun:sqlite";

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
      return {
        at, target,
        cpuCores: cpu.mean, cpuCoresMax: cpu.max,
        memoryBytes: mem.mean, memoryBytesMax: mem.max,
        load: stats(ps.map((p) => p.load)).mean,
      };
    });
}

type FineRow = { at: string; target: string; cpu_cores: number | null; memory_bytes: number | null; load: number | null };

/** Keep `points` (taken at `now`), roll up the windows that closed, drop what is past its window. One transaction. */
export function record(db: Database, points: readonly Point[], now: number): void {
  const put = db.query(
    `INSERT OR REPLACE INTO machine_sample
       (at, step, target, cpu_cores, cpu_cores_max, memory_bytes, memory_bytes_max, load)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const p of points) {
      put.run(iso(p.at), 15, p.target, p.cpuCores, p.cpuCores, p.memoryBytes, p.memoryBytes, p.load);
    }
    // Every window that ended by now and is not rolled yet: after the last rolled one.
    const last = db.query<{ at: string | null }, []>(
      "SELECT MAX(at) AS at FROM machine_sample WHERE step = 300",
    ).get()?.at;
    const from = last == null ? "" : iso(Date.parse(last) + COARSE_MS);
    const to = iso(Math.floor(now / COARSE_MS) * COARSE_MS);
    const fine = db.query<FineRow, [string, string]>(
      `SELECT at, target, cpu_cores, memory_bytes, load FROM machine_sample
        WHERE step = 15 AND at >= ? AND at < ?`,
    ).all(from, to);
    for (const r of rollUp(fine.map((f) => ({
      at: Date.parse(f.at), target: f.target, cpuCores: f.cpu_cores, memoryBytes: f.memory_bytes, load: f.load,
    })))) {
      put.run(iso(r.at), 300, r.target, r.cpuCores, r.cpuCoresMax, r.memoryBytes, r.memoryBytesMax, r.load);
    }
    db.query("DELETE FROM machine_sample WHERE step = 15 AND at < ?").run(iso(now - FINE_KEEP_MS));
    db.query("DELETE FROM machine_sample WHERE step = 300 AND at < ?").run(iso(now - COARSE_KEEP_MS));
  })();
}
