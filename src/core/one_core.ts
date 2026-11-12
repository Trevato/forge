import { availableParallelism } from "node:os";

/** True when a 1-CPU forge should hold background work for a crew run. */
export function crewHoldsCore(cpus: number, activeCrewRuns: number): boolean {
  return cpus <= 1 && activeCrewRuns > 0;
}

/** The forge's own CPU count, at least 1. */
export function forgeCpus(): number {
  const n = availableParallelism();
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
