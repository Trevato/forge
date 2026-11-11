/** The open pulls the flow keeper reads (#7556): one query, plain rows, and the few facts every part asks of them. */

import type { Database } from "bun:sqlite";
import { holdsFor, type Hold } from "../../core/holds.ts";
import { reviewSummariesFor } from "../../core/reviews.ts";

export interface KPull {
  readonly id: string;
  readonly repoId: string;
  /** `owner/name`. */
  readonly repo: string;
  readonly number: number;
  readonly authorId: string;
  readonly assigneeId: string | null;
  readonly headRepoId: string | null;
  readonly headBranch: string;
  readonly headOid: string;
  readonly approved: boolean;
  readonly hold: Hold | undefined;
}

interface Row {
  id: string;
  repo_id: string;
  repo: string;
  number: number;
  author_id: string;
  assignee_id: string | null;
  head_repo_id: string | null;
  head_branch: string;
  head_oid: string;
}

/** Open, unmerged pulls in repositories the crew works on its own. */
export function openPulls(db: Database): KPull[] {
  const rows = db
    .query<Row, []>(
      `SELECT issue.id, issue.repo_id, o.username || '/' || r.name AS repo, issue.number, issue.author_id,
              issue.assignee_id, pull.head_repo_id, pull.head_branch, pull.head_oid
         FROM issue JOIN pull ON pull.issue_id = issue.id
         JOIN repo r ON r.id = issue.repo_id JOIN user o ON o.id = r.owner_id
        WHERE issue.kind = 'pull' AND issue.state = 'open' AND pull.merged_at IS NULL
          AND r.autonomy != 'off' AND r.archived_at IS NULL
        ORDER BY issue.created_at, issue.id`,
    )
    .all();
  const verdicts = reviewSummariesFor(db, rows.map((p) => ({ id: p.id, headOid: p.head_oid })));
  const holds = holdsFor(db, rows.map((p) => p.id));
  return rows.map((p) => {
    const v = verdicts.get(p.id);
    return {
      id: p.id,
      repoId: p.repo_id,
      repo: p.repo,
      number: p.number,
      authorId: p.author_id,
      assigneeId: p.assignee_id,
      headRepoId: p.head_repo_id,
      headBranch: p.head_branch,
      headOid: p.head_oid,
      approved: v !== undefined && v.approvals > 0 && v.changesRequested === 0,
      hold: holds.get(p.id),
    };
  });
}

/** The newest check on the pull's head, if one has finished or is running. */
export function checkOn(db: Database, pull: Pick<KPull, "id" | "headOid">): { state: string; finishedAt: string | null } | undefined {
  return (
    db
      .query<{ state: string; finishedAt: string | null }, [string, string]>(
        `SELECT state, finished_at AS finishedAt FROM run
          WHERE issue_id = ?1 AND commit_oid = ?2 AND kind IN ('check','deploy')
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(pull.id, pull.headOid) ?? undefined
  );
}


/** The pull as its repository's words name it. */
export const nameOf = (p: Pick<KPull, "repo" | "number">): string => `${p.repo}#${p.number}`;
