/**
 * The forge's own memory against its JS heap, hour by hour (#2151): every
 * minute `process.memoryUsage().rss` and `heapStats().heapSize` (bun:jsc)
 * are folded into the hour they fall in (`memory_hour` in `app.db`, under
 * the data directory), as a count, a sum and a max. RSS rising while the
 * heap stays flat is native memory growth. A week of hours is kept.
 */
import type { Database } from "bun:sqlite";
import { heapStats } from "bun:jsc";
import type { App } from "../app.ts";
import { quietly } from "../core/write_clock.ts";

export const MEMORY_EVERY_MS = 60_000;
export const HOUR_MS = 3_600_000;
const KEEP_MS = 7 * 24 * HOUR_MS;

export type MemoryHour = {
  /** Epoch ms of the hour's start. */
  at: number;
  samples: number;
  rssMean: number;
  rssMax: number;
  heapMean: number;
  heapMax: number;
};

const valid = (n: number) => Number.isFinite(n) && n >= 0;

/** Fold one reading into its hour and drop hours past the week. Ignores a reading that is not a count of bytes. */
export function recordMemory(db: Database, rss: number, heap: number, now: number): void {
  if (!valid(rss) || !valid(heap) || !valid(now)) return;
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  db.transaction(() => quietly(db, () => {
    db.run(
      `INSERT INTO memory_hour (hour, samples, rss_sum, rss_max, heap_sum, heap_max) VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(hour) DO UPDATE SET samples = samples + 1, rss_sum = rss_sum + excluded.rss_sum,
         rss_max = max(rss_max, excluded.rss_max), heap_sum = heap_sum + excluded.heap_sum,
         heap_max = max(heap_max, excluded.heap_max)`,
      [hour, rss, rss, heap, heap],
    );
    db.run("DELETE FROM memory_hour WHERE hour < ?", [hour - KEEP_MS]);
  }))();
}

/** The hours in the `hours` before `now` (the current one included), oldest first. */
export function memoryHours(db: Database, now: number, hours = 24): MemoryHour[] {
  const last = Math.floor(now / HOUR_MS) * HOUR_MS;
  const rows = db
    .query<{ hour: number; samples: number; rss_sum: number; rss_max: number; heap_sum: number; heap_max: number }, [number, number]>(
      "SELECT hour, samples, rss_sum, rss_max, heap_sum, heap_max FROM memory_hour WHERE hour > ? AND hour <= ? ORDER BY hour",
    )
    .all(last - hours * HOUR_MS, last);
  return rows.map((r) => ({
    at: r.hour, samples: r.samples,
    rssMean: r.rss_sum / r.samples, rssMax: r.rss_max,
    heapMean: r.heap_sum / r.samples, heapMax: r.heap_max,
  }));
}

export type MemorySampler = { tick(now?: number): void; stop(): void };

/** Sample now and every minute until stopped. A failed tick is logged and the next one tries again. */
export function startMemorySampler(app: App, everyMs = MEMORY_EVERY_MS): MemorySampler {
  const tick = (now = Date.now()) => {
    try {
      recordMemory(app.db, process.memoryUsage().rss, heapStats().heapSize, now);
    } catch (error) {
      app.log.warn("memory sample failed", { error: String(error) });
    }
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}

/** Who may read the series: a forge admin who is a person, never an agent. The page, the nav and the terminal all ask this. */
export const canSeeMemory = (user: { isAdmin: boolean; kind?: string } | null | undefined): boolean =>
  user?.isAdmin === true && user.kind !== "agent";
