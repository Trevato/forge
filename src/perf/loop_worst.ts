/**
 * The worst event-loop lag of the last ten seconds (#10288), written on every
 * response as `lag;dur=<ms>` and told by `/healthz` as `loopLagMs`. A request
 * whose `app;dur` is 4 ms but whose time to first byte is 300 ms waited on a
 * loop blocked by something else; this names how long that block was.
 *
 * Lag is the lateness `kernel/loop_lag.ts` measures: a timer asks to wake
 * every 50 ms, and how much later than asked it wakes is how long the loop
 * was busy. A block of B ms is read as B − (time already waited, 0–50 ms),
 * so at 50 ms the reading undercounts a block by at most one interval.
 *
 * The window is a ring of ten one-second slots, each the worst lag noted in
 * its second: `note` is O(1) (a division, a compare, two array writes) and
 * `worst` reads ten numbers, so a tick costs well under 0.1 ms. A stall
 * stays named for 9–10 s after the wake that saw it, then falls out.
 */

import { LAG_EVERY_MS, startLoopLag } from "../kernel/loop_lag.ts";

/** The window `worst` covers, ms. */
export const LAG_WINDOW_MS = 10_000;
/** One slot of the ring, ms: the window's resolution. */
export const LAG_SLOT_MS = 1_000;

export interface LoopWorst {
  /** A wake `lateMs` late, seen at `at` (ms, the clock `worst` reads). */
  note(lateMs: number, at: number): void;
  /** The worst lateness noted in the window ending at `at`, ms; 0 when none. */
  worst(at: number): number;
}

export function createLoopWorst(
  windowMs = LAG_WINDOW_MS,
  slotMs = LAG_SLOT_MS,
): LoopWorst {
  const n = Math.max(1, Math.round(windowMs / slotMs));
  // slot[i] is which second (at / slotMs, floored) max[i] holds; -1 is empty.
  const slot = new Float64Array(n).fill(-1);
  const max = new Float64Array(n);
  return {
    note(lateMs, at) {
      if (!Number.isFinite(lateMs) || lateMs < 0 || !Number.isFinite(at)) return;
      const s = Math.floor(at / slotMs);
      const i = ((s % n) + n) % n;
      if (slot[i] !== s) {
        slot[i] = s;
        max[i] = lateMs;
      } else if (lateMs > max[i]!) max[i] = lateMs;
    },
    worst(at) {
      const now = Math.floor(at / slotMs);
      let w = 0;
      for (let i = 0; i < n; i++)
        if (slot[i]! > now - n && slot[i]! <= now && max[i]! > w) w = max[i]!;
      return w;
    },
  };
}

/** The process's one window, fed by `startLoopWorst`'s timer and read by every response. */
export const loopWorst = createLoopWorst();

let sampling: (() => void) | null = null;
/** The clock the window is read on; a test injects one to step ten seconds at once. */
let windowClock: () => number = () => performance.now();

export interface LoopWorstOptions {
  /** The window's clock, ms; lateness is always measured on `performance.now`. */
  readonly clock?: () => number;
  /** How often the timer asks to wake, ms. */
  readonly everyMs?: number;
}

/**
 * Start the one sampler feeding `loopWorst` (idempotent: a second server in
 * the same process shares it). Its timer is unref'd, so it never holds a
 * test or a shutdown open. Returns the stop, which also restores the clock.
 */
export function startLoopWorst(options: LoopWorstOptions = {}): () => void {
  if (sampling === null) {
    if (options.clock !== undefined) windowClock = options.clock;
    const lag = startLoopLag(options.everyMs ?? LAG_EVERY_MS, () => performance.now(), (late) =>
      loopWorst.note(late, windowClock()),
    );
    sampling = lag.stop;
  }
  return stopLoopWorst;
}

/** Stop the sampler, if one runs, and put the window back on `performance.now`. */
export function stopLoopWorst(): void {
  sampling?.();
  sampling = null;
  windowClock = () => performance.now();
}

/** The worst lag of the window ending now, ms, for a header or `/healthz`. */
export function currentLoopLag(): number {
  return loopWorst.worst(windowClock());
}

/**
 * Was a relayed request's wait the forge's, not the app's (#10838)? True when
 * the forge's worst loop lag (`forge-lag`) is more than half of the time to
 * the app's headers (`forge-ttfb`): most of that wait was the forge's loop
 * busy elsewhere, so the app must not be called slow. A non-finite or
 * negative reading, or a zero wait, never blames the forge.
 */
export function forgeWaited(lagMs: number, ttfbMs: number): boolean {
  if (!Number.isFinite(lagMs) || !Number.isFinite(ttfbMs) || lagMs < 0 || ttfbMs <= 0) return false;
  return lagMs > ttfbMs / 2;
}
