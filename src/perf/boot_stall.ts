/**
 * The worst event-loop stall in a process's first minutes (#8848). A release is
 * judged on how it behaves right after boot, when every sweep with its "last
 * time" in memory runs at once: 0.7.339 blocked the loop 46 s there while
 * earlier releases peaked at 2 to 4 s. The loop lag watch feeds each late wake;
 * only those ending inside the window count, so a stall hours later is the
 * ordinary watch's business, not the release's.
 */

/** The first minutes that count: 5 min after the process starts. */
export const BOOT_WINDOW_MS = 5 * 60_000;
/** A release whose worst stall in the window is over this is held from the next cut: 5 s. */
export const STALL_HOLD_MS = 5_000;

export interface BootStall {
  /** A wake `lateMs` late at `at` (ms on the process clock, 0 at its start). */
  note(lateMs: number, at: number): void;
  /** The worst lateness so far inside the window, ms. */
  worst(): number;
}

export function createBootStall(windowMs = BOOT_WINDOW_MS): BootStall {
  let worst = 0;
  return {
    note(lateMs, at) {
      if (at <= windowMs && lateMs > worst) worst = lateMs;
    },
    worst: () => Math.round(worst),
  };
}

/** The hold's reason: the stall, the limit, and the release before it. */
export function stallReason(version: string, ms: number, lastMs: number | undefined): string {
  const before = lastMs === undefined ? "" : ` (the release before: ${lastMs} ms)`;
  return `${version} blocked the event loop ${ms} ms in its first ${BOOT_WINDOW_MS / 60_000} minutes, over the ${STALL_HOLD_MS} ms limit${before}`;
}

/** The stall as a release row says it, beside the release before it when there is one: `1200 ms (last 800 ms)`. */
export function stallWords(ms: number, lastMs?: number): string {
  return `${ms} ms${lastMs === undefined ? "" : ` (last ${lastMs} ms)`}${ms > STALL_HOLD_MS ? " — held" : ""}`;
}
