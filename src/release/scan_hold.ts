/**
 * A new high finding holds a release (#9593). Before a landed tree of the
 * forge's own repository is swapped in, its open high findings are asked —
 * only those still in that tree (`presentAt`): a secret on a branch that
 * never landed, or one since removed, holds nothing. Any one left and the
 * release waits, saying how many and where to accept them. A person with
 * write access lifts the hold by accepting each with a reason
 * (`actions/scan_accept.ts`); nothing here prints the match. When the tree
 * cannot be read, every open high finding holds: silence never releases.
 */

import type { App } from "../app.ts";
import { presentAt } from "../checks/scan.ts";
import { openHigh } from "../checks/scan_store.ts";
import type { Repo } from "../core/repos.ts";

export type ScanHold = { held: false } | { held: true; count: number; line: string };

export async function scanHold(app: App, repo: Repo, sha: string): Promise<ScanHold> {
  const all = openHigh(app.db, repo.id);
  const open = (await presentAt(app, repo, sha, all)) ?? all;
  if (open.length === 0) return { held: false };
  const first = open[0]!;
  const where = `${first.rule} in ${first.path}${first.line > 0 ? `:${first.line}` : ""}`;
  const more = open.length === 1 ? "" : ` and ${open.length - 1} more`;
  return {
    held: true,
    count: open.length,
    line: `held by ${open.length} open high ${open.length === 1 ? "finding" : "findings"} (${where}${more}); a person with write access accepts each with a reason at /${repo.ownerName}/${repo.name}/findings`,
  };
}
