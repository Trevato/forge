/**
 * The last 20 one-minute worst loop-lag readings (#11220), so /system and the
 * MCP `system` tool show by eye whether the forge's idle `forge-lag` holds
 * under the 100 ms bar, without reading `/healthz` by hand.
 *
 * Fed by the same lag sampler as the boot stall and the loop watch (main.ts,
 * `kernel/loop_lag.ts`, a wake every 50 ms): each wake's lateness is folded
 * into the current minute's worst — a division, a compare and a store, no
 * allocation. When a wake lands in a new minute the old one is closed into a
 * fixed ring of `LAG_READINGS`: once a minute, its worst ms, the wall time it
 * began, and what it is blamed on — the worst stall `stallBlame` named in that
 * minute (the same name `/healthz` calls `loopWorstWhat`), or null when no
 * wake in it passed the 200 ms stall limit (`loop.ts`), so nothing was named.
 *
 * A minute the sampler never woke in (a suspended process) is not a reading:
 * the ring holds the last 20 minutes that were measured, oldest first.
 */

/** How many closed minutes the ring keeps. */
export const LAG_READINGS = 20;
/** The bar a minute's worst lag is held to, ms: over it is a miss (#11119). */
export const LAG_BAR_MS = 100;
/** One reading's span, ms. */
export const LAG_MINUTE_MS = 60_000;

export interface LagReading {
  /** When the minute began, wall clock ms since the epoch. */
  readonly at: number;
  /** The worst wake lateness in that minute, ms. */
  readonly ms: number;
  /** The route, `job:<name>` or `unknown` the minute's worst named stall ran under; null when none was named. */
  readonly what: string | null;
}

/** What ran under the worst named stall in `(to - spanMs, to]`, on the sampler's clock; null for none. */
export type MinuteBlame = (to: number, spanMs: number) => string | null;

export interface LagMinutes {
  /** A wake `lateMs` late at `at` (ms, the sampler's monotonic clock). O(1), allocates nothing until a minute closes. */
  note(lateMs: number, at: number): void;
  /** The closed minutes, oldest first; at most `LAG_READINGS`. */
  readings(): LagReading[];
  /** Forget every reading and the open minute. */
  clear(): void;
}

/** How many readings are over the bar (strictly: exactly 100 ms holds it). */
export const overBar = (rows: readonly LagReading[], barMs = LAG_BAR_MS): number =>
  rows.reduce((n, r) => (r.ms > barMs ? n + 1 : n), 0);

/**
 * `mono` and `wall` are one instant on the sampler's clock and the wall clock,
 * read when a minute closes, so a minute that began at `start` (mono) began at
 * `wall - (mono - start)`.
 */
export function createLagMinutes(
  blame: MinuteBlame = () => null,
  wall: () => number = () => Date.now(),
  kept = LAG_READINGS,
  minuteMs = LAG_MINUTE_MS,
): LagMinutes {
  const n = Math.max(1, Math.floor(kept));
  const at = new Float64Array(n);
  const ms = new Float64Array(n);
  const what: (string | null)[] = new Array<string | null>(n).fill(null);
  let next = 0;
  let count = 0;
  // The open minute: its index (floor(at / minuteMs)), -1 for none, and its worst.
  let minute = -1;
  let worst = 0;
  const close = (mono: number) => {
    const start = minute * minuteMs;
    at[next] = wall() - (mono - start);
    ms[next] = worst;
    what[next] = blame(start + minuteMs, minuteMs);
    next = (next + 1) % n;
    if (count < n) count++;
  };
  return {
    note(lateMs, now) {
      if (!Number.isFinite(lateMs) || lateMs < 0 || !Number.isFinite(now)) return;
      const m = Math.floor(now / minuteMs);
      if (m === minute) {
        if (lateMs > worst) worst = lateMs;
        return;
      }
      if (m < minute) return; // a clock that stepped back: keep the open minute
      if (minute >= 0) close(now);
      minute = m;
      worst = lateMs;
    },
    readings() {
      const out: LagReading[] = [];
      for (let k = 0; k < count; k++) {
        const i = (next - count + k + n) % n;
        out.push({ at: at[i]!, ms: ms[i]!, what: what[i]! });
      }
      return out;
    },
    clear() {
      next = 0;
      count = 0;
      minute = -1;
      worst = 0;
    },
  };
}
