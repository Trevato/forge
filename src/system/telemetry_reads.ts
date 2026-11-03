/**
 * Who reads a telemetry route, and how often (#8978). A reader polling too
 * often shows on /metrics as forge_telemetry_reads_total{route,reader}; the
 * rate is the counter's slope. Counted per process, bounded in names (the rest is reader="other").
 */

import type { Family } from "../metrics/openmetrics.ts";

const MAX_READERS = 200;
const counts = new Map<string, number>();

/** The window /system shows (#9069), and the mean interval under which a flow reader is too fast. */
export const WINDOW_MS = 10 * 60_000;
export const FAST_MEAN_MS = 5_000;
/** Per key: one slot per second (its second, and the reads in it), at most WINDOW_MS / 1000 slots. */
const slots = new Map<string, { sec: number; n: number }[]>();

/** Past the bound, a new reader is counted under "other" so no read goes uncounted. */
export function countRead(route: string, reader: string, now: number = Date.now()): void {
  let key = `${route}\n${reader}`;
  if (!counts.has(key) && counts.size >= MAX_READERS) key = `${route}\nother`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  const list = slots.get(key) ?? [];
  slots.set(key, list);
  const sec = Math.floor(now / 1000);
  const last = list[list.length - 1];
  if (last && last.sec === sec) last.n++;
  else list.push({ sec, n: 1 });
  const from = sec - WINDOW_MS / 1000;
  while (list.length > 0 && list[0]!.sec <= from) list.shift();
}

export interface ReaderPace {
  route: string;
  reader: string;
  reads: number;
  /** Mean milliseconds between the read seconds in the window; null with fewer than two. */
  meanIntervalMs: number | null;
  /** A reader on flow whose mean interval is under FAST_MEAN_MS. */
  tooFast: boolean;
}

/** Readers with a read in the last 10 minutes as of `now`, most reads first. A scan of at most 200 keys x 600 slots. */
export function readerPaces(now: number = Date.now()): ReaderPace[] {
  const from = Math.floor(now / 1000) - WINDOW_MS / 1000;
  const out: ReaderPace[] = [];
  for (const [key, list] of slots) {
    while (list.length > 0 && list[0]!.sec <= from) list.shift();
    if (list.length === 0) continue;
    const [route, reader] = key.split("\n") as [string, string];
    const reads = list.reduce((a, s) => a + s.n, 0);
    const meanIntervalMs = list.length < 2 ? null : ((list[list.length - 1]!.sec - list[0]!.sec) * 1000) / (list.length - 1);
    out.push({ route, reader, reads, meanIntervalMs, tooFast: route === "flow" && meanIntervalMs !== null && meanIntervalMs < FAST_MEAN_MS });
  }
  return out.sort((a, b) => b.reads - a.reads || a.reader.localeCompare(b.reader));
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
  slots.clear();
}
