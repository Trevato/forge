/**
 * When a cell's CPU use is a stop. Pure: plain data in, a boolean out; no clock,
 * no I/O. Called by the cell watch (`apps/contain.ts` tick, #11657).
 *
 * Rule: cores used > CPU_STOP_FACTOR × the cell's cpus, held continuously for at
 * least CPU_STOP_HOLD_MS, and the cell at least CPU_STOP_GRACE_MS old.
 *
 * The cost of the grace, chosen (#11657): the watch is the only bound on a cell
 * the kernel does not hold (no delegated `cpu.max`) and affinity does not pin
 * (`taskset` absent). Such a cell — an untrusted check included — may use every
 * core of the host for up to CPU_STOP_GRACE_MS (10 minutes) before it can be
 * stopped, and must keep it up for CPU_STOP_HOLD_MS. A cell whose cores are the
 * whole machine is within its limit at any load. The other choice, a quick stop,
 * is what killed a sized forge's builds at 2.1 of 1 core after 31 s; where the
 * kernel holds the quota or `taskset` pins the cores this cost does not arise.
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

/** The next `overSinceMs`: kept while cores stay over the line, set to now when they cross it, null when they drop under. */
function overSince(prev: number | null, cores: number, cpus: number, nowMs: number): number | null {
  if (!(cores > CPU_STOP_FACTOR * cpus)) return null;
  return prev ?? nowMs;
}

/** What one tick of the watch decides: the hold to keep, and whether to stop. */
export interface CpuVerdict {
  readonly overSinceMs: number | null;
  readonly stop: boolean;
}

/**
 * One tick of the watch's decision, pure: the new `overSinceMs` and whether the cell is
 * stopped. The watch keeps the first and acts on the second (`apps/contain.ts`, #11657).
 */
export function cpuWatch(
  prevOverSinceMs: number | null,
  cores: number,
  cpus: number,
  nowMs: number,
  startedAtMs: number,
): CpuVerdict {
  const overSinceMs = overSince(prevOverSinceMs, cores, cpus, nowMs);
  return { overSinceMs, stop: cpuStop({ cores, cpus, overSinceMs, nowMs, startedAtMs }) };
}
