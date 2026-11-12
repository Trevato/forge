/**
 * When a cell's CPU use is a stop. Pure: plain data in, a boolean out; no clock,
 * no I/O. No caller yet (#11612, part of #11539).
 *
 * Rule: cores used > CPU_STOP_FACTOR × the cell's cpus, held continuously for at
 * least CPU_STOP_HOLD_MS, and the cell at least CPU_STOP_GRACE_MS old.
 */

/** A cell is over its limit only past this multiple of its cores. */
export const CPU_STOP_FACTOR = 2;
/** The overage must have held this long, milliseconds. */
export const CPU_STOP_HOLD_MS = 5 * 60_000;
/** A cell younger than this is never stopped, milliseconds. */
export const CPU_STOP_GRACE_MS = 10 * 60_000;

export interface CpuStopInput {
  /** Cores used now (averaged by the caller). */
  readonly cores: number;
  /** Cores the cell is allowed; Infinity when the kernel already caps it. */
  readonly cpus: number;
  /** When `cores > CPU_STOP_FACTOR * cpus` began to hold without a break, epoch ms; null if it does not hold. */
  readonly overSinceMs: number | null;
  readonly nowMs: number;
  /** When the cell started, epoch ms. */
  readonly startedAtMs: number;
}

export function cpuStop(i: CpuStopInput): boolean {
  const { cores, cpus, overSinceMs, nowMs, startedAtMs } = i;
  if (![cores, cpus, nowMs, startedAtMs].every((n) => typeof n === "number" && !Number.isNaN(n))) return false;
  if (overSinceMs === null || Number.isNaN(overSinceMs)) return false;
  if (!(cores > CPU_STOP_FACTOR * cpus)) return false;
  if (nowMs - overSinceMs < CPU_STOP_HOLD_MS) return false;
  return nowMs - startedAtMs >= CPU_STOP_GRACE_MS;
}
