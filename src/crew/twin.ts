/**
 * The same work asked for twice. Two issues with one title are one job: a
 * build run on the second, while the first has a run going or a pull open
 * (or merged), only makes a pull to be closed or an "already done".
 *
 * A twin is another open issue of the repository with the same title, case
 * and edge spaces aside. A pull titled the same stands as one too, unless it
 * is the issue's own (its branch carries the issue's number). A merged pull
 * only counts when it landed after this issue was opened, so a title that
 * comes round again ("Fix typo") can be built again.
 *
 * What stands in front is named, so the log and the person on the issue can
 * say why nothing started.
 */
import type { Database } from "bun:sqlite";
import type { Issue } from "../core/issues.ts";

export interface Twin {
  /** The issue or pull that holds the work. */
  readonly number: number;
  /** In flight: a run or an open pull. Landed: a pull merged. */
  readonly standing: "running" | "open" | "landed";
}

/** Same-title issues whose branches are asked after: the newest are the ones still in play. */
const TWINS_ASKED = 8;

const same = (title: string): string => title.trim().toLowerCase();

/** The twin, if any, already holding `issue`'s work: running before open before landed. */
export function twinOf(db: Database, issue: Pick<Issue, "id" | "repoId" | "number" | "title" | "createdAt">): Twin | undefined {
  const t = same(issue.title);
  if (t === "") return undefined;
  const running = db
    .query<{ number: number }, [string, string, string]>(
      `SELECT i.number FROM issue i
        WHERE i.repo_id = ?1 AND i.id != ?2 AND i.kind = 'issue' AND i.state = 'open'
          AND lower(trim(i.title)) = ?3
          AND EXISTS (SELECT 1 FROM run r WHERE r.issue_id = i.id AND r.kind = 'agent'
                       AND r.state IN ('queued','running'))
        ORDER BY i.number LIMIT 1`,
    )
    .get(issue.repoId, issue.id, t);
  if (running !== null) return { number: running.number, standing: "running" };
  // A pull is another issue row; it answers a twin by its own title, or by
  // the number its builder's branch carries (`<agent>/<number>-<slug>`). The
  // same-title issues are read first: this runs on the main thread inside
  // queueAgentRun, and matching every pull against every issue took 10 s.
  const numbers = db
    .query<{ number: number }, [string, string, string]>(
      `SELECT number FROM issue
        WHERE repo_id = ?1 AND id != ?2 AND kind = 'issue' AND lower(trim(title)) = ?3
        ORDER BY number DESC LIMIT ${TWINS_ASKED}`,
    )
    .all(issue.repoId, issue.id, t)
    .map((r) => r.number);
  const branches = numbers.flatMap((n) => [`%/${n}`, `%/${n}-%`]);
  const pull = db
    .query<{ number: number; merged: number }, string[]>(
      `SELECT p.number, (pl.merged_at IS NOT NULL) AS merged
         FROM issue p JOIN pull pl ON pl.issue_id = p.id
        WHERE p.repo_id = ? AND p.kind = 'pull' AND p.id != ?
          AND (p.state = 'open' OR pl.merged_at >= ?)
          AND pl.head_branch NOT LIKE ? AND pl.head_branch NOT LIKE ?
          AND (lower(trim(p.title)) = ?${branches.map(() => " OR pl.head_branch LIKE ?").join("")})
        ORDER BY (pl.merged_at IS NOT NULL), p.number LIMIT 1`,
    )
    .get(issue.repoId, issue.id, issue.createdAt, `%/${issue.number}`, `%/${issue.number}-%`, t, ...branches);
  if (pull === null) return undefined;
  return { number: pull.number, standing: pull.merged === 1 ? "landed" : "open" };
}

/** The words for the issue's thread: which twin holds the work, and that nothing started. */
export function twinNote(twin: Twin): string {
  const state = { running: "is running", open: "has a pull open", landed: "has landed" }[twin.standing];
  return `#${twin.number} already holds this work (${twin.standing}): it ${state}, so no build run was started here. Close this issue as a duplicate, or retitle it if it is different work.`;
}
