/**
 * A person's cancel, in words (#11229). `cancelRepoRun` marks the row with
 * `cancelledBy(name)`; the worker that was running it, once it has wound
 * down, ends the run's log with that same line, so the log's last word says
 * the run was cancelled and by whom. A run cancelled any other way (its
 * pull landed, a budget, a restart) keeps the summary its own path writes.
 */

const PREFIX = "cancelled by ";

/** The summary and the log's last line for a run `username` cancelled. */
export const cancelledBy = (username: string): string => `${PREFIX}${username}`;

/**
 * The line a worker ends a run's log with, given the row it finds when its
 * work is over: the row's summary when a person cancelled it, else nothing.
 */
export function cancelledLine(
  row: { readonly state: string; readonly summary: string } | undefined,
): string | undefined {
  if (row === undefined || row.state !== "cancelled") return undefined;
  return row.summary.startsWith(PREFIX) && row.summary.length > PREFIX.length
    ? row.summary
    : undefined;
}
