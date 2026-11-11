/**
 * A bring-up-to-date run is queued when a pull stops merging into its base.
 * By the time it starts, main may have moved again or the clash may have
 * been settled, and the pull merges clean: there is nothing for an agent.
 * The forge says so and the pull lands through the queue as it is (one of
 * six conflict runs on 2026-11-09 began with "Clean merge. Verify." —
 * eight turns, a slot and a check for nothing). Agents get real conflicts.
 */

import type { App } from "../app.ts";
import { pullDir, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { mergeable, resolveOid } from "../git/merge.ts";

/** The run's summary when the forge found nothing to bring up to date. */
export const MERGES_CLEAN_NOW =
  "main merges clean now: nothing to bring up to date, no agent run";

/** Whether the pull's head merges into its base's current tip without conflict; false when the base cannot be read. */
export async function mergesCleanNow(
  app: App,
  repo: Repo,
  pull: Pull,
): Promise<boolean> {
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const baseTip = await resolveOid(dir, `refs/heads/${pull.baseBranch}`);
  if (baseTip === undefined) return false;
  return (await mergeable(dir, baseTip, pull.headOid)).ok;
}
