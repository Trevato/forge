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
 *
 * {@link releaseCheck} is what a release reads (#3966): the tagged commit's
 * own check when it has a verdict, and otherwise — main moved on and
 * cancelled it, or the commit landed inside a batch that was checked only
 * at its head — the newest of main's checks of a later commit that contains
 * it. That check ran the full suite on the tagged tree plus what landed
 * after, so its green covers the tag. `checkedCommit` names whose check
 * answered.
 */

import type { Database } from "bun:sqlite";

/** How many of a repository's newest runs are looked through. */
export const WINDOW = 5000;

export type CommitCheckState = "ok" | "failed" | "pending" | "superseded" | "none";

export interface CommitCheck {
  readonly commit: string;
  /** Whose check answered: `commit` itself, or a later main commit containing it. */
  readonly checkedCommit: string;
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
  if (row === null)
    return { commit: oid, checkedCommit: oid, state: "none", runId: null, summary: "", finishedAt: null };
  const state: CommitCheckState =
    row.state === "ok" || row.state === "failed"
      ? row.state
      : row.state === "cancelled"
        ? "superseded"
        : "pending";
  return {
    commit: oid,
    checkedCommit: oid,
    state,
    runId: row.id,
    summary: row.summary,
    finishedAt: row.finished_at,
  };
}

/**
 * The own verdicts, `ok` or `failed`, of a page of commits in one query: what
 * a log list marks. A commit with no verdict yet is absent from the map.
 */
export function commitVerdicts(
  db: Database,
  repoId: string,
  branch: string,
  oids: readonly string[],
): Map<string, CommitCheck> {
  const out = new Map<string, CommitCheck>();
  const wanted = new Set(oids.filter(isCommitId));
  if (wanted.size === 0) return out;
  const rows = db
    .query<
      { id: string; commit_oid: string; state: string; summary: string; finished_at: string | null },
      [string, string, number]
    >(
      `SELECT id, commit_oid, state, summary, finished_at
         FROM (SELECT id, kind, issue_id, env, commit_oid, state, summary, finished_at
                 FROM run WHERE repo_id = ?1 ORDER BY id DESC LIMIT ?3)
        WHERE kind = 'check' AND issue_id IS NULL AND env = ?2
          AND state IN ('ok', 'failed')
        ORDER BY id DESC`,
    )
    .all(repoId, branch, WINDOW);
  for (const row of rows) {
    if (!wanted.has(row.commit_oid) || out.has(row.commit_oid)) continue;
    out.set(row.commit_oid, {
      commit: row.commit_oid,
      checkedCommit: row.commit_oid,
      state: row.state as "ok" | "failed",
      runId: row.id,
      summary: row.summary,
      finishedAt: row.finished_at,
    });
  }
  return out;
}

/** How many later commits main checked are asked whether they contain the tag. */
export const DESCENDANTS = 10;

/**
 * The check a release on `oid` waits on. The commit's own `ok`, `failed` or
 * `pending` answers as it is. When it is `superseded` or `none`, main's
 * checks of later commits (newest first, at most {@link DESCENDANTS}
 * distinct commits, each by its own newest non-cancelled check) are asked
 * in turn: the first green one that `contains` the commit answers `ok`; a
 * containing one still running answers `pending`, so the release waits for
 * it. A red one is not a verdict on the tag and is passed over; when nothing
 * green or running contains the commit the commit's own answer stands.
 *
 * `history.contains(descendant)` says whether `oid` is reachable from
 * `descendant` (`git merge-base --is-ancestor`); `history.has()` says whether
 * `oid` is a commit in the repository at all, and is asked once before any
 * `contains`, so an oid the repository never saw costs one git process, not
 * one per descendant (the endpoint is unauthenticated on a public repo).
 * Both are passed in so this stays plain data.
 */
export async function releaseCheck(
  db: Database,
  repoId: string,
  branch: string,
  oid: string,
  history: { has: () => Promise<boolean>; contains: (descendant: string) => Promise<boolean> },
): Promise<CommitCheck> {
  const own = commitCheck(db, repoId, branch, oid);
  if (own.state !== "superseded" && own.state !== "none") return own;
  const rows = db
    .query<
      { id: string; commit_oid: string; state: string; summary: string; finished_at: string | null },
      [string, string, string, number, string]
    >(
      `SELECT id, commit_oid, state, summary, finished_at
         FROM (SELECT id, kind, issue_id, env, commit_oid, state, summary, finished_at
                 FROM run WHERE repo_id = ?1 ORDER BY id DESC LIMIT ?4)
        WHERE kind = 'check' AND issue_id IS NULL AND env = ?2
          AND commit_oid IS NOT NULL AND commit_oid NOT IN ('', ?3) AND state <> 'cancelled'
          AND id > ?5
        ORDER BY id DESC`,
    )
    .all(repoId, branch, oid, WINDOW, own.runId ?? "");
  const seen = new Set<string>();
  let waiting: CommitCheck | null = null;
  let known: boolean | null = null;
  for (const row of rows) {
    if (seen.has(row.commit_oid)) continue;
    seen.add(row.commit_oid);
    if (seen.size > DESCENDANTS) break;
    if (row.state === "failed") continue;
    const pending = row.state !== "ok";
    if (pending && waiting !== null) continue;
    known ??= await history.has();
    if (!known) return own;
    if (!(await history.contains(row.commit_oid))) continue;
    const answer: CommitCheck = {
      commit: oid,
      checkedCommit: row.commit_oid,
      state: pending ? "pending" : "ok",
      runId: row.id,
      summary: row.summary,
      finishedAt: row.finished_at,
    };
    if (!pending) return answer;
    waiting = answer;
  }
  return waiting ?? own;
}
