/**
 * An approved pull that stays red gets one more look, then goes back (#6349).
 *
 * #3885 sat approved and red for 5.5 days: nothing moved a pull whose
 * check failed after its approval. Every tick, for each open crew pull
 * approved on its head whose latest check of that head failed
 * {@link RED_AFTER_MS} ago or more:
 *
 * - No re-check was ever queued for the head: one is, reason `recheck`,
 *   and a comment says so. One per head, never two; a push is a new head.
 * - The re-check ended red: the crew reviewer who approved the head
 *   requests changes on it, in one line naming the first failing test
 *   from the check's summary. That verdict is what `requested.ts` hands
 *   to the pull's builder, so the pass needs no run of its own.
 * - The re-check ended green, or is still running: nothing.
 */

import type { App } from "../app.ts";
import { addComment } from "../actions/issues.ts";
import { checksFor } from "../checks/service.ts";
import { listCrewRoles } from "../core/agents.ts";
import { getIssueById } from "../core/issues.ts";
import { listPulls, pullDir, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { listReviews, submitReview } from "../core/reviews.ts";
import { getRun, INFRA_SUMMARY, type Run } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { resolveOid } from "../git/merge.ts";
import { createLog } from "../kernel/log.ts";
import { approvedOnHead } from "./finishing.ts";

const log = createLog("crew");

/** How long a head stays red after its approval before it is checked once more. */
export const RED_AFTER_MS = 24 * 3_600_000;

/** The reason the re-check carries. */
export const RECHECK = "recheck";

/** What the pass did with one pull. */
export interface RedMove {
  readonly pull: number;
  readonly did: "re-check queued" | "handed back";
}

/** The check runs of this head of the pull, newest first. */
function checksOfHead(app: App, pull: Pull): Run[] {
  return app.db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM run WHERE kind = 'check' AND issue_id = ?1 AND commit_oid = ?2 ORDER BY id DESC`,
    )
    .all(pull.id, pull.headOid)
    .map((r) => getRun(app.db, r.id)!);
}

/** The line a hand-back says: the first failing test, else the check's own summary. */
export function failingLine(run: Run): string {
  const name = run.checkDetail?.names[0];
  const said = name !== undefined && name !== "" ? name : run.summary.trim().split("\n")[0] ?? "";
  return said.slice(0, 200) || "the check failed";
}

export async function recheckRedApproved(app: App, repo: Repo, now: Date): Promise<RedMove[]> {
  if (repo.autonomy !== "autonomous") return [];
  const moves: RedMove[] = [];
  const reviewers = listCrewRoles(app.db, repo.id)
    .filter((c) => c.role === "reviewer")
    .map((c) => c.agent.user);
  if (reviewers.length === 0) return moves;
  for (const pull of listPulls(app.db, repo.id, { sealed: true, state: "open", limit: 50 })) {
    if (!pull.authorIsAgent || pull.mergedAt !== null || pull.headOid === "") continue;
    if (!approvedOnHead(app.db, pull)) continue;
    const issue = getIssueById(app.db, pull.id);
    if (!issue || issue.state !== "open") continue;
    const runs = checksOfHead(app, pull);
    // A check in flight is the head's answer to come: nothing to say yet.
    if (runs.some((r) => r.state === "queued" || r.state === "running") && !runs.some((r) => r.reason === RECHECK && r.state === "failed")) continue;
    const again = runs.find((r) => r.reason === RECHECK);
    const by =
      reviewers.find((u) =>
        listReviews(app.db, pull.id).some(
          (r) => r.authorId === u.id && r.state === "approved" && r.commitOid === pull.headOid,
        ),
      ) ?? reviewers[0]!;
    if (again !== undefined) {
      if (again.state !== "failed") continue;
      // A machine failure is no verdict on the code (#6263): the pull stays approved.
      if (again.summary.startsWith(INFRA_SUMMARY)) continue;
      const line = `Red again after approval: ${failingLine(again)}`;
      const sent = submitReview(app.db, {
        issueId: pull.id,
        authorId: by.id,
        state: "changes_requested",
        body: line,
        commitOid: pull.headOid,
      });
      if (!sent.ok) continue;
      log.info("approved pull red after its re-check: handed back", {
        repo: `${repo.ownerName}/${repo.name}`,
        pull: pull.number,
      });
      moves.push({ pull: pull.number, did: "handed back" });
      continue;
    }
    const last = runs.find((r) => r.state === "ok" || r.state === "failed");
    if (last?.state !== "failed" || last.finishedAt === null) continue;
    if (now.getTime() - Date.parse(last.finishedAt) < RED_AFTER_MS) continue;
    const checks = checksFor(app);
    if (checks === undefined) continue;
    // The head as it is now, as `askCheck` reads it.
    const dir = await pullDir(app.db, app.reposRoot, repo, pull);
    const ref = pull.crossRepo ? `refs/pull/${pull.number}/head` : `refs/heads/${pull.headBranch}`;
    if ((await resolveOid(dir, ref)) !== pull.headOid) continue;
    const queued = await checks.request(repo, `pull-${pull.number}`, pull.headOid, RECHECK, pull.id);
    // `request` hands back a check already in flight, which is not ours.
    if (queued?.reason !== RECHECK) continue;
    addComment(
      app,
      getUserById(app.db, by.id),
      repo,
      issue,
      `This pull is approved but its check has been red for 24 h (${failingLine(last)}). One re-check is queued; if it is red too, the pull goes back to its builder.`,
    );
    moves.push({ pull: pull.number, did: "re-check queued" });
  }
  return moves;
}
