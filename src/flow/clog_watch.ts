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
  /** Quiet readings in a row so far; absent when zero. */
  readonly quiet?: number;
}

export type ClogEvent = "started" | "cleared";

export interface ClogStep {
  readonly state: ClogState | null;
  readonly event: ClogEvent | null;
  /** On "cleared": when the clog had started. */
  readonly since?: number;
}

export function clogStep(prev: ClogState | null, reading: readonly string[], now: number): ClogStep {
  if (!prev) {
    if (reading.length === 0) return { state: null, event: null };
    return { state: { since: now, firstReasons: [...reading] }, event: "started" };
  }
  if (reading.length > 0) return { state: { since: prev.since, firstReasons: prev.firstReasons }, event: null };
  const quiet = (prev.quiet ?? 0) + 1;
  if (quiet >= QUIET_TO_CLEAR) return { state: null, event: "cleared", since: prev.since };
  return { state: { ...prev, quiet }, event: null };
}
