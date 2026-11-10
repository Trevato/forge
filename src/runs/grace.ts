/**
 * How long a cancelled run has to end on its own (#10919). A cancel asks
 * the run's process group to stop (SIGTERM), so a step can flush its last
 * output and remove its temporary files. Whatever is still alive once the
 * grace runs out gets SIGKILL, sent to the group and never to a pid outside it.
 *
 * Why 1.5 s: a cancel promises the person who pressed it that the run's
 * whole tree is gone within 2 s (`test/run-cancel-tree.test.ts`), so a run
 * that ignores SIGTERM has to be killed early enough to keep that promise.
 * A process that honours SIGTERM ends in milliseconds, so 1.5 s is far more
 * than it needs.
 */
export const CANCEL_GRACE_MS = 1_500;

/** The run log line written when the grace ran out and the group was killed. */
export function graceKillLine(graceMs: number = CANCEL_GRACE_MS): string {
  return `cancel: still running after ${(graceMs / 1000).toFixed(1)} s grace, killed`;
}
