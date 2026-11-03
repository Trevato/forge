/**
 * Who reads a telemetry route, and how often (#8978). A reader polling too
 * often shows on /metrics as forge_telemetry_reads_total{route,reader}; the
 * rate is the counter's slope. Counted per process, bounded in names (the rest is reader="other").
 */

import type { Family } from "../metrics/openmetrics.ts";

const MAX_READERS = 200;
const counts = new Map<string, number>();

/** Past the bound, a new reader is counted under "other" so no read goes uncounted. */
export function countRead(route: string, reader: string): void {
  let key = `${route}\n${reader}`;
  if (!counts.has(key) && counts.size >= MAX_READERS) key = `${route}\nother`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function telemetryReadsFamily(): Family {
  return {
    type: "counter",
    name: "forge_telemetry_reads_total",
    help: "Reads of /api/v1/telemetry routes by route and reader since the process started.",
    samples: [...counts].map(([key, value]) => {
      const [route, reader] = key.split("\n") as [string, string];
      return { labels: { route, reader }, value };
    }),
  };
}

export function resetTelemetryReads(): void {
  counts.clear();
}
