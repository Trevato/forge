/**
 * How late the forge's event loop runs (#3319): a timer asks to wake every
 * `everyMs`, and how much later than that it actually wakes is the time a
 * request arriving then would have waited before the forge could even read
 * it. A loop starved of CPU (a full lane of checks beside it) shows here
 * before a probe times out.
 *
 * `take()` hands back the 99th percentile of the lateness since the last
 * take, in ms, and starts a new window; null when no timer fired in it.
 */

import type { Log } from "./log.ts";

export type LoopLag = { take(): number | null; stop(): void };

/** How often the timer asks to wake, ms: 20 wakes a second, no measurable cost. */
export const LAG_EVERY_MS = 50;

/** The most samples one window keeps: 15 s at 50 ms is 300; a stalled sampler never grows it past this. */
const MAX_SAMPLES = 4096;

/**
 * Nearest-rank percentile `p` (0 < p ≤ 100) of `xs`: the value at rank
 * ⌈p/100 · n⌉ of the sorted list (NIST/Hyndman–Fan definition 1). Null
 * for an empty list.
 */
export function nearestRank(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/** Start measuring; `now` is a clock in ms (`performance.now` in production); `onLate` hears every wake's lateness. */
export function startLoopLag(
  everyMs = LAG_EVERY_MS,
  now: () => number = () => performance.now(),
  onLate?: (lateMs: number) => void,
): LoopLag {
  let samples: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const due = now() + everyMs;
    timer = setTimeout(() => {
      // Early by a fraction of a ms is timer rounding, not a fast loop.
      const late = Math.max(0, now() - due);
      if (samples.length < MAX_SAMPLES) samples.push(late);
      onLate?.(late);
      arm();
    }, everyMs);
    timer.unref?.();
  };
  arm();
  return {
    take: () => {
      const p99 = nearestRank(samples, 99);
      samples = [];
      return p99;
    },
    stop: () => clearTimeout(timer),
  };
}

/** A wake this late is a stall worth a warning (#6957): a readiness probe gives up at 1 s. */
export const STALL_WARN_MS = 1_000;

/**
 * The always-on gauge (#6957): from boot, every wake later than `warnMs` is
 * one warning saying how late, so a stall that keeps /healthz from answering
 * names its minute in the log. Returns the stop.
 */
export function watchStalls(
  log: Pick<Log, "warn">,
  warnMs = STALL_WARN_MS,
  everyMs = LAG_EVERY_MS,
  now: () => number = () => performance.now(),
  onStall?: (lateMs: number, at: number) => void,
): () => void {
  const lag = startLoopLag(everyMs, now, (late) => {
    onStall?.(late, now());
    if (late >= warnMs) log.warn("event loop stalled", { lateMs: Math.round(late) });
  });
  return lag.stop;
}
