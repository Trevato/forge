/**
 * The default branch's own check of one commit: half of a release's gate of
 * record (#2794). A release ships when the forge's full check — the
 * `check.run` that every push to the default branch runs, never a pull's
 * fast tier — passed on the very commit the release builds; the other half
 * is the image proving it boots (`release/boot.ts`, in the Dockerfile).
 *
 * Plain data: the newest check of `oid` pushed to `branch`, read from the
 * newest {@link WINDOW} runs of the repository by the `run_repo` index, so
 * the answer costs the same however many runs a repository has.
 *
 * A cancelled check is passed over when another check of the commit stands
 * beside it: a restart cancels a running check and queues it again in one
 * transaction (`requeueCheck`), so the newer attempt answers. When every
 * check of the commit was cancelled, nothing will check it again — main
 * moved on while it waited (`superseded by <sha>`, `checks/service.ts`) or
 * a person stopped it — and the answer is `superseded`, never `none`, so a
 * release on that commit stops at once rather than waiting out its budget.
 */

import type { Database } from "bun:sqlite";

/** How many of a repository's newest runs are looked through. */
export const WINDOW = 5000;

export type CommitCheckState = "ok" | "failed" | "pending" | "superseded" | "none";

export interface CommitCheck {
  readonly commit: string;
  /**
   * `ok` passed, `failed` failed, `pending` queued or running, `superseded`
   * every check of it was cancelled and none will follow, `none` never checked.
   */
  readonly state: CommitCheckState;
  readonly runId: string | null;
  readonly summary: string;
  readonly finishedAt: string | null;
}

/** A full commit id: what a release names, and the only form asked about. */
export const isCommitId = (oid: string): boolean => /^[0-9a-f]{40}$/.test(oid);

export function commitCheck(
  db: Database,
  repoId: string,
  branch: string,
  oid: string,
): CommitCheck {
  const row = db
    .query<
      { id: string; state: string; summary: string; finished_at: string | null },
      [string, string, string, number]
    >(
      `SELECT id, state, summary, finished_at
         FROM (SELECT id, kind, issue_id, env, commit_oid, state, summary, finished_at
                 FROM run WHERE repo_id = ?1 ORDER BY id DESC LIMIT ?4)
        WHERE kind = 'check' AND issue_id IS NULL AND env = ?2
          AND commit_oid = ?3
        ORDER BY state <> 'cancelled' DESC, id DESC LIMIT 1`,
    )
    .get(repoId, branch, oid, WINDOW);
  if (row === null) return { commit: oid, state: "none", runId: null, summary: "", finishedAt: null };
  const state: CommitCheckState =
    row.state === "ok" || row.state === "failed"
      ? row.state
      : row.state === "cancelled"
        ? "superseded"
        : "pending";
  return { commit: oid, state, runId: row.id, summary: row.summary, finishedAt: row.finished_at };
}
