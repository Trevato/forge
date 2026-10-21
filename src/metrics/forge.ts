/**
 * The forge's own families for `GET /metrics` (#3975, #3752): request duration
 * as a histogram per route pattern, and the apps, up or not, with each cell's
 * CPU and memory as the watch last read them. The duration is read from the
 * totals `route_timing` keeps in memory since the process started, not from
 * the hourly table, so every value only grows (#4013): Prometheus reads a drop
 * as a counter reset, and a restart resets them, which it expects. Nothing is
 * started or shelled out to read a figure. The text comes from `openmetrics.ts`.
 */
import type { Database } from "bun:sqlite";
import type { CellCounter } from "../apps/contain.ts";
import type { EnvState } from "../apps/runtime.ts";
import { EDGES_MS, readTotals } from "../core/route_timing.ts";
import { openMetrics, type Family, type HistogramSample, type Sample } from "./openmetrics.ts";

export const DURATION_FAMILY = "forge_http_request_duration_seconds";

/** The duration histogram since the process started: cumulative buckets, in seconds. */
export function durationFamily(db: Database): Family {
  const samples: HistogramSample[] = [];
  for (const [pattern, t] of [...readTotals(db)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let running = 0;
    const buckets = EDGES_MS.map((ms, i) => {
      running += t.counts[i] ?? 0;
      return { le: ms / 1000, count: running };
    });
    const count = running + (t.counts[EDGES_MS.length] ?? 0);
    samples.push({ labels: { pattern }, buckets, count, sum: t.sumUs / 1e6 });
  }
  return {
    type: "histogram",
    name: DURATION_FAMILY,
    help: "Seconds the forge took to answer a request, by route pattern, since the process started.",
    samples,
  };
}

export const UP_FAMILY = "forge_app_up";
export const CELL_CPU_FAMILY = "forge_cell_cpu_seconds_total";
export const CELL_MEMORY_FAMILY = "forge_cell_memory_bytes";

/** One app as the runtime holds it: who it is, whether it is private, and each environment's state. */
export interface AppReading {
  readonly id: string;
  readonly slug: string;
  readonly private: boolean;
  readonly envs: readonly { readonly env: string; readonly state: EnvState }[];
}

/** What the app families read: the runtime's recorded states and the watch's counters. */
export interface AppSources {
  readonly apps: readonly AppReading[];
  readonly cells: readonly CellCounter[];
}

/** A private app is named by its id alone, never its slug. */
const nameOf = (a: AppReading): string => (a.private ? a.id : a.slug);

/** `forge_app_up` per app and environment, and each running cell's CPU and memory. */
export function appFamilies({ apps, cells }: AppSources): Family[] {
  const sorted = [...apps].sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : 1));
  const up: Sample[] = [];
  const cpu: Sample[] = [];
  const mem: Sample[] = [];
  // The watch labels a cell `app:<slug>/<env>`, and during a deploy the old
  // and new cells share a label: their figures add up to the environment's.
  const byCell = new Map<string, { cpuUsec: number; memoryBytes: number }>();
  for (const c of cells) {
    if (!c.label.startsWith("app:")) continue;
    const key = c.label.slice(4);
    const held = byCell.get(key) ?? { cpuUsec: 0, memoryBytes: 0 };
    held.cpuUsec += c.cpuUsec;
    held.memoryBytes += c.memoryBytes;
    byCell.set(key, held);
  }
  for (const a of sorted) {
    const app = nameOf(a);
    for (const e of a.envs)
      up.push({ labels: { app, env: e.env }, value: e.state === "running" ? 1 : 0 });
    for (const e of a.envs) {
      const c = byCell.get(`${a.slug}/${e.env}`);
      if (c === undefined) continue;
      const labels = { app, env: e.env };
      cpu.push({ labels, value: c.cpuUsec / 1e6 });
      mem.push({ labels, value: c.memoryBytes });
    }
  }
  return [
    { type: "gauge", name: UP_FAMILY, help: "1 when the app environment is serving, 0 when it is asleep, stopped, deploying or failed.", samples: up },
    { type: "counter", name: CELL_CPU_FAMILY, help: "CPU seconds, user plus system, used by the processes of an app cell since it started.", samples: cpu },
    { type: "gauge", name: CELL_MEMORY_FAMILY, help: "Resident memory in bytes of the processes of an app cell.", samples: mem },
  ];
}

/** The forge's families as Prometheus text (no `# EOF`: the body is `text/plain; version=0.0.4`). */
export function forgeMetrics(
  db: Database,
  sources: AppSources = { apps: [], cells: [] },
): string {
  return openMetrics([durationFamily(db), ...appFamilies(sources)]).replace(/# EOF\n$/, "");
}
