/**
 * Folding in (#8937): work from a trusted source flows to the default
 * branch without a person's review, and without skipping anything else —
 * its check, the boot proof and the walls still stand. A branch becomes a
 * pull only through the upstream follow (`actions/upstream_follow.ts`),
 * which records where it came from; the autonomy tick's own `sweepGreen`
 * then admits it like the crew's. This module is what is left: the note
 * before a trust lapses and the revert of one source's work. The walls are
 * in `fold_walls.ts`.
 */
import type { App } from "../app.ts";
import { getIssueById } from "../core/issues.ts";
import { getPull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { dueWarning, markWarned, pullIdsFrom } from "../core/trusted_sources.ts";
import type { User } from "../core/users.ts";
import { revertPull } from "../actions/revert.ts";

/** The note 3 days before a trust ends: an event the owner's feed shows, once per entry. */
export function warnExpiring(app: App, now: Date = new Date()): number {
  const due = dueWarning(app.db, now);
  for (const source of due) {
    app.bus.append({
      kind: "trust.expiring",
      payload: { account: source.account, host: source.host, until: source.until },
    });
    markWarned(app.db, source.id, now);
  }
  return due.length;
}

/**
 * A bad landing reverts by source: every merged pull of one source in this
 * repository becomes a revert pull, newest first, for a person to land.
 * Which pulls were reverted, and which could not be.
 */
export async function revertSource(
  app: App,
  actor: User,
  repo: Repo,
  host: string,
  account: string,
): Promise<{ opened: number[]; refused: number[] }> {
  const opened: number[] = [];
  const refused: number[] = [];
  for (const id of pullIdsFrom(app.db, host, account)) {
    const issue = getIssueById(app.db, id);
    if (issue === undefined || issue.repoId !== repo.id) continue;
    const pull = getPull(app.db, repo.id, issue.number);
    if (pull === undefined || pull.mergedAt === null) continue;
    const reverted = await revertPull(app, actor, repo, pull, `Reverts #${pull.number}, folded in from ${account}@${host}.`);
    (reverted.ok ? opened : refused).push(pull.number);
  }
  return { opened, refused };
}
