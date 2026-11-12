/**
 * The slowest wait the forge relayed to each app's production in the last
 * ten minutes (#10858), and whose wait it was. The proxy notes every relay's
 * time to the app's headers (`forge-ttfb`) beside the forge's worst loop lag
 * at that moment (`forge-lag`, `perf/loop_worst.ts`); the app's speed card
 * and its terminal line say it in words. When the lag explains more than
 * half the wait (`forgeWaited`, the one place the rule lives), the words
 * say the forge was busy, not the app.
 *
 * When the wait was the forge's, it also says what held it (#11000): the
 * stalls the loop watch named (`perf/loop.ts`) in the lag's window, as route
 * patterns or `job:<name>`, the longest stall first. Patterns only — a name
 * that is not one (`isStallPattern`) is never told — and only to the app's
 * owners, on the speed card and the terminal line; a signed-in forge admin
 * also gets them on the relayed answer as `forge-stall` (`stallTiming`).
 *
 * Every reading here is taken on the server side, whoever asked: the
 * relayed answer's `forge-*` entries go only to the app's writers and the
 * forge's admins (#11112), and nothing here reads them back from a header.
 *
 * Process memory, not the database: one O(1) compare per relay, at most
 * `KEEP_APPS` apps (the oldest reading goes first), gone on restart. The
 * stalls are read only when the forge waited, and at most `HELD_NAMES` kept.
 */

import { blamed, NO_REQUEST, type Stall } from "../perf/loop.ts";
import { forgeWaited } from "../perf/loop_worst.ts";

/** How long a slowest wait stays told, ms. */
export const WAIT_WINDOW_MS = 10 * 60 * 1000;
/** The most apps held; past it the stalest reading is dropped. */
export const KEEP_APPS = 2_000;
/** The most stall names told for one wait. */
export const HELD_NAMES = 3;

/** One stall that held a wait: what ran across it, and how long it blocked, ms. */
export interface HeldBy {
  readonly name: string;
  readonly ms: number;
}

/**
 * Whether `name` is a route pattern or a job's name, and so safe to tell: a
 * path pattern (`/:owner/:name`), `job:<name>`, or the unmatched bucket. No
 * query, no quote, no space, nothing a header's quoted string would need
 * escaped, at most 120 characters.
 */
export function isStallPattern(name: string): boolean {
  return name.length <= 120 && /^(?:\/[A-Za-z0-9_:.\/*#-]*|job:[A-Za-z0-9_.:-]+|\(unmatched\))$/.test(name);
}

/**
 * What held a wait, from the stalls of its window: each stall's names
 * (routes, else jobs), the longest stall first, each name once, the
 * unnamed (`NO_REQUEST`) and anything not a pattern dropped, at most `HELD_NAMES`.
 */
export function heldBy(stalls: readonly Stall[]): HeldBy[] {
  const out: HeldBy[] = [];
  const seen = new Set<string>();
  for (const s of [...stalls].sort((a, b) => b.lateMs - a.lateMs))
    for (const name of blamed(s)) {
      if (out.length >= HELD_NAMES) return out;
      if (name === NO_REQUEST || seen.has(name) || !isStallPattern(name)) continue;
      seen.add(name);
      out.push({ name, ms: s.lateMs });
    }
  return out;
}

export interface RelayWait {
  /** Time to the app's headers, on the forge's clock, ms. */
  readonly ttfbMs: number;
  /** The forge's worst event-loop lag of the 10 s before, ms. */
  readonly lagMs: number;
  /** When it was relayed, ms since the epoch. */
  readonly at: number;
  /** True when the forge's lag explains most of the wait (`forgeWaited`). */
  readonly forge: boolean;
  /** What held it, longest first; empty unless `forge`. */
  readonly held: readonly HeldBy[];
}

const slowest = new Map<string, RelayWait>();

/**
 * Note one relayed wait for `appId`; it is kept when it is the window's
 * slowest. `held` is what held it (`heldBy`), kept only when the forge waited.
 */
export function noteRelayWait(
  appId: string,
  ttfbMs: number,
  lagMs: number,
  at: number = Date.now(),
  held: readonly HeldBy[] = [],
): void {
  if (!Number.isFinite(ttfbMs) || ttfbMs < 0 || !Number.isFinite(lagMs) || lagMs < 0) return;
  const kept = slowest.get(appId);
  if (kept !== undefined && at - kept.at < WAIT_WINDOW_MS && kept.ttfbMs >= ttfbMs) return;
  if (kept === undefined && slowest.size >= KEEP_APPS) {
    // Maps keep insertion order and a replacement re-inserts, so the first is the stalest.
    const first = slowest.keys().next().value;
    if (first !== undefined) slowest.delete(first);
  }
  slowest.delete(appId);
  const forge = forgeWaited(lagMs, ttfbMs);
  slowest.set(appId, { ttfbMs, lagMs, at, forge, held: forge ? held : [] });
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
 * 600 ms of the 820 ms wait, held by job:sweep (600 ms)" or "820 ms, the
 * app's own". Plain text; callers escape.
 */
export function relayWaitWords(w: RelayWait): string {
  if (!w.forge) return `${msText(w.ttfbMs)}, the app's own`;
  const busy = `the forge was busy: ${msText(w.lagMs)} of the ${msText(w.ttfbMs)} wait`;
  return w.held.length === 0 ? busy : `${busy}, held by ${w.held.map((h) => `${h.name} (${msText(h.ms)})`).join(", ")}`;
}

/**
 * What held a wait as `Server-Timing` entries, for a forge admin's eyes only:
 * `forge-stall;desc="/explore";dur=1226.8`, one per name. Names are checked
 * again here (`isStallPattern`), so nothing that needs escaping is written.
 */
export function stallTiming(held: readonly HeldBy[]): string {
  return held
    .filter((h) => isStallPattern(h.name) && Number.isFinite(h.ms) && h.ms >= 0)
    .map((h) => `forge-stall;desc="${h.name}";dur=${h.ms.toFixed(1)}`)
    .join(", ");
}
