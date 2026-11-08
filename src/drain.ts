/**
 * How long a SIGTERM'd forge lets its work finish before it hands it back
 * queued (#7799). The new forge holds its own queue work until the old one
 * stops writing, so these budgets are the write pause of a release: seconds,
 * not the ten minutes a full gate takes. What is cut off is queued again and
 * resumes on the new forge.
 */

/** Seconds, for checks, merge-queue gates and crew runs alike, unless the environment says. */
export const DRAIN_DEFAULT_S = 10;

export interface DrainBudgets {
  readonly checksMs: number;
  readonly crewMs: number;
}

/** A positive number of seconds, else the default: junk never lengthens a roll. */
function seconds(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) || DRAIN_DEFAULT_S : DRAIN_DEFAULT_S;
}

/** `FORGE_CHECKS_DRAIN_S` and `FORGE_CREW_DRAIN_S`, in milliseconds. */
export function drainBudgets(env: Readonly<Record<string, string | undefined>>): DrainBudgets {
  return {
    checksMs: seconds(env["FORGE_CHECKS_DRAIN_S"]) * 1000,
    crewMs: seconds(env["FORGE_CREW_DRAIN_S"]) * 1000,
  };
}
