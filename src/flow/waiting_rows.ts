/**
 * What waits on `/flow`, from the database alone: approved pulls the merge
 * queue has not landed, per repository with the oldest, and open crew pulls
 * with no push for days. The third list, work a crew fork never proposed, asks
 * git and is read apart (`alarm_unproposed.ts`).
 */

import type { Database } from "bun:sqlite";
import { closesFromBody } from "../core/pulls.ts";
import type { UnproposedAlarm } from "./alarm_unproposed.ts";
import { approvedWait, type ApprovedRow, type ApprovedWait } from "./approved_wait.ts";
import { staleFold, type StaleFold } from "./stale_fold.ts";

export interface Waiting {
  readonly approved: readonly ApprovedWait[];
  readonly stale: readonly (StaleFold & { readonly repo: string })[];
  readonly unproposed: UnproposedAlarm;
}

/** Open, unlanded pulls whose latest verdict is an approval, with when it came. */
export function approvedRows(db: Database): ApprovedRow[] {
  return db
    .query<{ repo: string; number: number; at: string }, []>(
      `SELECT ro.username || '/' || r.name AS repo, i.number AS number, a.at AS at
         FROM pull p
         JOIN issue i ON i.id = p.issue_id
         JOIN repo r ON r.id = i.repo_id
         JOIN user ro ON ro.id = r.owner_id
         JOIN (SELECT issue_id, MAX(created_at) AS at FROM review WHERE state = 'approved' GROUP BY issue_id) a ON a.issue_id = i.id
        WHERE i.state = 'open' AND p.merged_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM review c WHERE c.issue_id = i.id AND c.state = 'changes_requested' AND c.created_at > a.at)`,
    )
    .all()
    .map((x) => ({ repo: x.repo, number: x.number, approvedAt: x.at }));
}

/** Open crew pulls with the time of their newest push (their opening when none), and whether they are approved. */
function crewPulls(db: Database): { repo: string; pull: Parameters<typeof staleFold>[0][number] }[] {
  return db
    .query<{ repo: string; number: number; branch: string; body: string; moved: string; approved: number }, []>(
      `SELECT ro.username || '/' || r.name AS repo, i.number AS number, p.head_branch AS branch, i.body AS body,
              COALESCE((SELECT MAX(e.created_at) FROM event e
                         WHERE e.repo_id = i.repo_id AND e.kind = 'pull.pushed'
                           AND json_extract(e.payload, '$.number') = i.number + 0), i.created_at) AS moved,
              EXISTS (SELECT 1 FROM review a WHERE a.issue_id = i.id AND a.state = 'approved'
                        AND NOT EXISTS (SELECT 1 FROM review c WHERE c.issue_id = i.id AND c.state = 'changes_requested' AND c.created_at > a.created_at)) AS approved
         FROM pull p
         JOIN issue i ON i.id = p.issue_id AND i.state = 'open' AND i.kind = 'pull'
         JOIN repo r ON r.id = i.repo_id
         JOIN user ro ON ro.id = r.owner_id
         JOIN user u ON u.id = i.author_id AND u.is_agent = 1
        WHERE p.merged_at IS NULL`,
    )
    .all()
    .map((x) => ({
      repo: x.repo,
      pull: { number: x.number, issueNumber: closesFromBody(x.body)[0] ?? null, branch: x.branch, lastPushAt: x.moved, approved: x.approved === 1 },
    }));
}

/** The two lists the database holds. */
export function readWaitingRows(db: Database, now: Date): Pick<Waiting, "approved" | "stale"> {
  const pulls = crewPulls(db);
  return { approved: approvedWait(approvedRows(db), now), stale: staleFold(pulls.map((p) => ({ ...p.pull, repo: p.repo })), now) };
}
