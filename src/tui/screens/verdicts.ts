/**
 * Where a page of pulls stands with its reviewers, in one query and one
 * `for-each-ref`.
 *
 * A pull list wants one mark per row — approved, changes requested, nobody
 * has looked — and the shape a `RepoSource` hands a list (`IssueSummary`)
 * cannot say. The honest fix is a grouped reader beside `mergedPullNumbers`
 * in `core/pulls.ts` (`countsForRepos` / `labelsForIssues` are the pattern:
 * ids in, `Map` out, one query per chunk). **That is where this belongs**;
 * it lives here only because `core/` is being edited on another branch, and
 * a per-row `listReviews` would have been an N+1 on the hottest list in the
 * forge — the one thing the repo's own recipe forbids.
 *
 * **The head has to be the live one.** A verdict counts only when it was
 * passed on the commit that is the head *now* — that is the whole of
 * `reviewSummary` — and reading it against `pull.head_oid` (the snapshot
 * taken when the pull opened) would mark every pull whose branch has moved
 * as unreviewed. So the refs are read once for the whole page with a single
 * `for-each-ref`, never once per row: `refs/heads/<branch>` for a same-repo
 * pull and `refs/pull/<n>/head` for a cross-repo one, exactly the refs
 * `pullStatus` resolves. A mirrored pull's head lives on the origin and is
 * not ours to resolve, so it falls back to the recorded oid.
 *
 * It decides a glyph and nothing else: `mergePull` is the gate, mechanically,
 * and it reads its own head at the moment of the merge.
 */

import type { Database } from "bun:sqlite";
import { listRefs } from "../../git/read.ts";

export type Verdict = "approved" | "changes_requested" | "none";

interface Row {
  number: number;
  repo_id: string;
  head_oid: string;
  head_branch: string;
  head_repo_id: string | null;
  origin_head_repo: string | null;
  who: string;
  state: "approved" | "changes_requested" | "commented";
  commit_oid: string;
}

/** SQLite takes a bounded parameter list; the same chunk core's readers use. */
const CHUNK = 400;

export async function verdictsForPulls(
  db: Database,
  dir: string,
  repoId: string,
  numbers: readonly number[],
): Promise<Map<number, Verdict>> {
  const out = new Map<number, Verdict>();
  const unique = [...new Set(numbers)];
  if (unique.length === 0) return out;
  /** Per pull, each reviewer's latest verdict — the way core keys it. */
  const latest = new Map<number, Map<string, Row>>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<Row, (string | number)[]>(
        `SELECT issue.number AS number,
                issue.repo_id AS repo_id,
                pull.head_oid AS head_oid,
                pull.head_branch AS head_branch,
                pull.head_repo_id AS head_repo_id,
                pull.origin_head_repo AS origin_head_repo,
                COALESCE(review.origin_author, review.author_id) AS who,
                review.state AS state,
                review.commit_oid AS commit_oid
         FROM issue
         JOIN pull ON pull.issue_id = issue.id
         JOIN review ON review.issue_id = issue.id
         WHERE issue.repo_id = ?1
           AND issue.number IN (${batch.map((_, n) => `?${n + 2}`).join(",")})
         ORDER BY review.id`,
      )
      .all(repoId, ...batch);
    // Ordered by id, so the last write for a reviewer is their current
    // stance — the same rule `latestReviewByAuthor` applies.
    for (const row of rows) {
      const seen = latest.get(row.number) ?? new Map<string, Row>();
      seen.set(row.who, row);
      latest.set(row.number, seen);
    }
  }
  if (latest.size === 0) return out;

  // One spawn for the whole page. `refs/` rather than two narrower prefixes,
  // because a second spawn to save a few hundred bytes of stdout is the
  // wrong trade in a process that has already paid for one.
  const refs = await listRefs(dir);
  const tips = new Map<string, string>();
  if (refs.ok) for (const ref of refs.value) tips.set(ref.name, ref.oid);

  for (const [number, reviewers] of latest) {
    let approvals = 0;
    let blocked = false;
    for (const row of reviewers.values()) {
      if (row.commit_oid !== headOf(row, tips)) continue;
      if (row.state === "approved") approvals++;
      else if (row.state === "changes_requested") blocked = true;
    }
    out.set(
      number,
      blocked ? "changes_requested" : approvals > 0 ? "approved" : "none",
    );
  }
  return out;
}

/** The head this pull is proposing *now* — `pullStatus`'s own resolution. */
function headOf(row: Row, tips: ReadonlyMap<string, string>): string {
  if (row.origin_head_repo !== null) return row.head_oid;
  const crossRepo =
    row.head_repo_id !== null && row.head_repo_id !== row.repo_id;
  const ref = crossRepo
    ? `refs/pull/${row.number}/head`
    : `refs/heads/${row.head_branch}`;
  return tips.get(ref) ?? row.head_oid;
}
