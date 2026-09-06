/**
 * The agent runs in flight in this process, by run id. A cancel from any
 * surface aborts the controller; the runner sees the abort and stops the
 * child. Kept apart from the dispatcher so an action can reach it without
 * importing the worker.
 */

const running = new Map<string, AbortController>();

export function trackAgentRun(
  runId: string,
  controller: AbortController,
): void {
  running.set(runId, controller);
}

export function untrackAgentRun(runId: string): void {
  running.delete(runId);
}

/** Stop a running agent run. A run not in flight here is left alone. */
export function abortAgentRun(runId: string): boolean {
  const controller = running.get(runId);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}

export const runningAgentRuns = (): number => running.size;
