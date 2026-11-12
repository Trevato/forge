import type { Database } from "bun:sqlite";
import { availableParallelism } from "node:os";

/** True when a 1-CPU forge should hold background work for a crew run; more CPUs never count the runs. */
export function crewHoldsCore(cpus: number, activeCrewRuns: () => number): boolean {
  return cpus <= 1 && activeCrewRuns() > 0;
}

/** The forge's own CPU count, at least 1. */
export function forgeCpus(): number {
  const n = availableParallelism();
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Crew runs working now: agent runs in the `running` state. */
export function activeCrewRuns(db: Database): number {
  const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run WHERE kind = 'agent' AND state = 'running'").get();
  return row?.n ?? 0;
}

/** The longest a check or a snapshot waits for a crew run on one CPU before it starts anyway. */
export const MAX_HOLD_MS = 10 * 60_000;

/**
 * Whether work keyed `key` is still held at `now`. The first time it is held
 * starts its clock; once `maxMs` has passed it is held no longer, so crew runs
 * back to back cannot starve it. `release` forgets the key when the work starts,
 * `keep` forgets every key not named (work cancelled or superseded), and
 * `reset` forgets them all once no crew run holds, so a later run holds afresh.
 */
export function holdClock(maxMs = MAX_HOLD_MS) {
  const since = new Map<string, number>();
  return {
    held(key: string, now: number): boolean {
      const first = since.get(key) ?? now;
      since.set(key, first);
      return now - first < maxMs;
    },
    release(key: string): void {
      since.delete(key);
    },
    keep(keys: ReadonlySet<string>): void {
      for (const key of since.keys()) if (!keys.has(key)) since.delete(key);
    },
    reset(): void {
      since.clear();
    },
  };
}
