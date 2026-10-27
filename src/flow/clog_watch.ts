/**
 * Clog watch (#6518): turns a stream of clog readings into one "started" and
 * one "cleared" event per clog. A reading is the list of reasons the flow is
 * clogged now (empty when it is not). A clog clears only after QUIET_TO_CLEAR
 * quiet readings in a row, so a flapping reason does not notify twice.
 */

export const QUIET_TO_CLEAR = 2;

export interface ClogState {
  /** When the clog started, epoch ms. */
  readonly since: number;
  /** The reasons on the reading that started it. */
  readonly firstReasons: readonly string[];
  /** When it really began (the oldest stuck item's wait, say); never after `since`. Absent: it began when declared. */
  readonly startedAt?: number;
  /** Quiet readings in a row so far; absent when zero. */
  readonly quiet?: number;
  /** The most stranded dollars seen while it stood; kept by the tick, not by the step. */
  readonly peakUsd?: number;
}

export type ClogEvent = "started" | "cleared";

export interface ClogStep {
  readonly state: ClogState | null;
  readonly event: ClogEvent | null;
  /** On "cleared": when the clog had started. */
  readonly since?: number;
  /** On "cleared": when it really began. */
  readonly startedAt?: number;
}

/** `startedAt` is when the reading says the clog began (the reading's own time when it cannot tell); it counts only on the reading that declares it. */
export function clogStep(prev: ClogState | null, reading: readonly string[], now: number, startedAt: number = now): ClogStep {
  if (!prev) {
    if (reading.length === 0) return { state: null, event: null };
    const began = Number.isFinite(startedAt) ? Math.min(startedAt, now) : now;
    return { state: { since: now, firstReasons: [...reading], startedAt: began }, event: "started" };
  }
  if (reading.length > 0)
    return {
      state: {
        since: prev.since,
        firstReasons: prev.firstReasons,
        ...(prev.startedAt === undefined ? {} : { startedAt: prev.startedAt }),
        ...(prev.peakUsd === undefined ? {} : { peakUsd: prev.peakUsd }),
      },
      event: null,
    };
  const quiet = (prev.quiet ?? 0) + 1;
  if (quiet >= QUIET_TO_CLEAR) return { state: null, event: "cleared", since: prev.since, ...(prev.startedAt === undefined ? {} : { startedAt: prev.startedAt }) };
  return { state: { ...prev, quiet }, event: null };
}
