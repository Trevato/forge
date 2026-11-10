/**
 * The slowest wait the forge relayed to each app's production in the last
 * ten minutes (#10858), and whose wait it was. The proxy notes every relay's
 * time to the app's headers (`forge-ttfb`) beside the forge's worst loop lag
 * at that moment (`forge-lag`, `perf/loop_worst.ts`); the app's speed card
 * and its terminal line say it in words. When the lag explains more than
 * half the wait (`forgeWaited`, the one place the rule lives), the words
 * say the forge was busy, not the app.
 *
 * Process memory, not the database: one O(1) compare per relay, at most
 * `KEEP_APPS` apps (the oldest reading goes first), gone on restart.
 */

import { forgeWaited } from "../perf/loop_worst.ts";

/** How long a slowest wait stays told, ms. */
export const WAIT_WINDOW_MS = 10 * 60 * 1000;
/** The most apps held; past it the stalest reading is dropped. */
export const KEEP_APPS = 2_000;

export interface RelayWait {
  /** Time to the app's headers, on the forge's clock, ms. */
  readonly ttfbMs: number;
  /** The forge's worst event-loop lag of the 10 s before, ms. */
  readonly lagMs: number;
  /** When it was relayed, ms since the epoch. */
  readonly at: number;
  /** True when the forge's lag explains most of the wait (`forgeWaited`). */
  readonly forge: boolean;
}

const slowest = new Map<string, RelayWait>();

/** Note one relayed wait for `appId`; it is kept when it is the window's slowest. */
export function noteRelayWait(appId: string, ttfbMs: number, lagMs: number, at: number = Date.now()): void {
  if (!Number.isFinite(ttfbMs) || ttfbMs < 0 || !Number.isFinite(lagMs) || lagMs < 0) return;
  const held = slowest.get(appId);
  if (held !== undefined && at - held.at < WAIT_WINDOW_MS && held.ttfbMs >= ttfbMs) return;
  if (held === undefined && slowest.size >= KEEP_APPS) {
    // Maps keep insertion order and a replacement re-inserts, so the first is the stalest.
    const first = slowest.keys().next().value;
    if (first !== undefined) slowest.delete(first);
  }
  slowest.delete(appId);
  slowest.set(appId, { ttfbMs, lagMs, at, forge: forgeWaited(lagMs, ttfbMs) });
}

/** The slowest wait of the window ending at `at`, or undefined with none. */
export function relayWait(appId: string, at: number = Date.now()): RelayWait | undefined {
  const held = slowest.get(appId);
  return held !== undefined && at - held.at < WAIT_WINDOW_MS ? held : undefined;
}

/** Forget every reading (tests). */
export function clearRelayWaits(): void {
  slowest.clear();
}

const msText = (v: number): string => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);

/**
 * The reading in one plain sentence, whose wait first: "the forge was busy:
 * 600 ms of the 820 ms wait" or "820 ms, the app's own". Plain text; callers escape.
 */
export function relayWaitWords(w: RelayWait): string {
  return w.forge ? `the forge was busy: ${msText(w.lagMs)} of the ${msText(w.ttfbMs)} wait` : `${msText(w.ttfbMs)}, the app's own`;
}
