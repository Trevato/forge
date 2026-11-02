/**
 * When a run last did something: a line in its log, or a plan update
 * (#8707). Kept in memory, set where the log is written. A run the forge has
 * not seen act since it started is measured from its start; a restart cancels
 * the runs in flight, so nothing needs this to outlive the process.
 */

/** Runs remembered: the oldest is dropped past this. */
const KEPT = 2000;
const lastAt = new Map<string, number>();

export function noteActivity(runId: string, at: number = Date.now()): void {
  lastAt.delete(runId);
  lastAt.set(runId, at);
  if (lastAt.size > KEPT) lastAt.delete(lastAt.keys().next().value!);
}

export const lastActivity = (runId: string): number | undefined => lastAt.get(runId);
