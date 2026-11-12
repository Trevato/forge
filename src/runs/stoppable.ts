/**
 * The runs in flight in this process that a cancel can stop, by run id
 * (#10776). Whatever works a run registers its controller here for as long
 * as it works it; a cancel from any surface (`actions/runs.ts`) marks the
 * row and then aborts the controller, and the worker's abort ends the
 * process group it started (`apps/process.ts` `runStep`). A run worked by
 * another forge process is not here: its row says cancelled, and that
 * process's own end leaves it so.
 *
 * Agent runs keep their own registry (`crew/running.ts`), which the crew
 * dispatcher counts and stops by; this one is for the rest.
 */

const running = new Map<string, AbortController>();

export function trackRun(runId: string, controller: AbortController): void {
  running.set(runId, controller);
}

/** Forget a run, but only if `controller` is still the one tracked for it. */
export function untrackRun(runId: string, controller: AbortController): void {
  if (running.get(runId) === controller) running.delete(runId);
}

/** Stop a run worked in this process. A run not in flight here is left alone. */
export function stopRun(runId: string): boolean {
  const controller = running.get(runId);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}

/** Whether a run is still being worked in this process. */
export const runningRun = (runId: string): boolean => running.has(runId);
