/**
 * Whether an approval sends a pull's head through the lane again (#4391).
 *
 * An approval is what lets a reader's pull run, so a head that has never
 * been checked is checked when it is approved. But a crew reviewer approves
 * nearly every pull minutes after its push check passed, and checking that
 * head again cost the lane a full run per pull: 21 of 52 heads in one hour
 * were checked twice, and 27 checks queued behind them.
 *
 * A head already green in its environment is checked again only when that
 * says something new: its base has moved since the green check merged with
 * it, and nothing else will judge the pull on today's base. An autonomous
 * repository's land gates the merge on today's base anyway
 * (`checks/landing.ts`), so there the approval adds nothing.
 */

import type { Run } from "../core/runs.ts";

export function checkOnApproval(
  /** The runs at this head (`checksForHead`). */
  runs: readonly Run[],
  /** The environment the pull's checks run in, `pull-<n>`. */
  env: string,
  /** The base branch's tip now; undefined when it could not be read. */
  baseTip: string | undefined,
  /** Whether the pull lands through the merge queue's full gate. */
  landGated: boolean,
): boolean {
  const green = runs.filter(
    (r) => r.kind === "check" && r.env === env && r.state === "ok",
  );
  if (green.length === 0) return true;
  if (landGated || baseTip === undefined) return false;
  return !green.some((r) => r.baseOid === baseTip);
}
