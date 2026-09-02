/**
 * Pull requests: an issue (kind "pull") with a base and head branch. The
 * diff and the commits live in git; this row records intent and outcome. On
 * merge we write refs/pull/N/merged so the merge commit stays reachable
 * forever, even if the base branch is later deleted and gc runs — the gap
 * Forgejo left open (#30972).
 */

import type { Database } from "bun:sqlite";
import { diffRange, type Diff } from "../git/diff.ts";
import { isSafeRef } from "../git/guard.ts";
import {
  aheadCount,
  fetchInto,
  merge,
  mergeBase,
  mergeable,
  resolveOid,
  writeRef,
  type MergeError,
  type MergeStrategy,
} from "../git/merge.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import {
  createIssue,
  getIssue,
  getIssueById,
  listIssues,
  setIssueState,
  type Issue,
  type ListIssuesOptions,
} from "./issues.ts";

export interface Pull extends Issue {
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly mergedAt: string | null;
  readonly mergedOid: string | null;
  /** The repo the head branch lives in — a fork for a cross-repo PR, else the
   * base repo (this pull's repoId). */
  readonly headRepoId: string;
  readonly crossRepo: boolean;
}

interface PullRow {
  base_branch: string;
  head_branch: string;
  base_oid: string;
  head_oid: string;
  merged_at: string | null;
  merged_oid: string | null;
  head_repo_id: string | null;
}

function join(db: Database, issue: Issue): Pull | undefined {
  const row = db
    .query<PullRow, [string]>("SELECT * FROM pull WHERE issue_id = ?1")
    .get(issue.id);
  if (!row) return undefined;
  const headRepoId = row.head_repo_id ?? issue.repoId;
  return {
    ...issue,
    baseBranch: row.base_branch,
    headBranch: row.head_branch,
    baseOid: row.base_oid,
    headOid: row.head_oid,
    mergedAt: row.merged_at,
    mergedOid: row.merged_oid,
    headRepoId,
    crossRepo: headRepoId !== issue.repoId,
  };
}

export type CreatePullError =
  | "empty_title"
  | "invalid_branch"
  | "same_branch"
  | "unknown_base"
  | "unknown_head"
  | "nothing_to_merge";

export interface CreatePullInput {
  /** The base (upstream) repo the PR is created in. */
  repoId: string;
  authorId: string;
  title: string;
  body?: string;
  baseBranch: string;
  headBranch: string;
  /** For a cross-repo PR: the fork the head branch lives in. Defaults to the
   * base repo (a same-repo PR). */
  headRepoId?: string;
  /** The fork's on-disk dir, required when headRepoId differs from the base. */
  headDir?: string;
}

export async function createPull(
  db: Database,
  dir: string,
  input: CreatePullInput,
): Promise<Result<Pull, CreatePullError>> {
  if (!isSafeRef(input.baseBranch) || !isSafeRef(input.headBranch))
    return err("invalid_branch");

  const crossRepo =
    input.headRepoId !== undefined && input.headRepoId !== input.repoId;
  if (!crossRepo && input.baseBranch === input.headBranch)
    return err("same_branch");

  const baseOid = await resolveOid(dir, `refs/heads/${input.baseBranch}`);
  if (!baseOid) return err("unknown_base");

  // Same-repo: read the head from this repo. Cross-repo: fetch the fork's head
  // branch into the base repo (bringing its objects), and diff/merge in-base.
  const headOid = crossRepo
    ? await fetchInto(dir, input.headDir!, `refs/heads/${input.headBranch}`)
    : await resolveOid(dir, `refs/heads/${input.headBranch}`);
  if (!headOid) return err("unknown_head");
  if ((await aheadCount(dir, baseOid, headOid)) === 0)
    return err("nothing_to_merge");

  const issue = createIssue(db, {
    repoId: input.repoId,
    authorId: input.authorId,
    title: input.title,
    body: input.body ?? "",
    kind: "pull",
  });
  if (!issue.ok) return err("empty_title");

  const headRepoId = input.headRepoId ?? input.repoId;
  db.query(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(
    issue.value.id,
    input.baseBranch,
    input.headBranch,
    baseOid,
    headOid,
    headRepoId,
  );

  // A durable, fetchable ref for the PR head — the way tooling addresses it,
  // and (for cross-repo) the only place the base repo holds the fork's tip.
  await writeRef(dir, `refs/pull/${issue.value.number}/head`, headOid);

  return ok(join(db, issue.value)!);
}

export function getPull(
  db: Database,
  repoId: string,
  number: number,
): Pull | undefined {
  const issue = getIssue(db, repoId, number);
  if (!issue || issue.kind !== "pull") return undefined;
  return join(db, issue);
}

export type ListPullsOptions = Omit<ListIssuesOptions, "kind">;

export function listPulls(
  db: Database,
  repoId: string,
  options: ListPullsOptions = {},
): Pull[] {
  return listIssues(db, repoId, { ...options, kind: "pull" })
    .map((issue) => join(db, issue))
    .filter((p): p is Pull => p !== undefined);
}

export interface PullDiff {
  readonly status: PullStatus;
  /** The merge base the diff is taken from (the base tip if none). */
  readonly from: string;
  readonly diff: Diff;
}

/**
 * What the pull changes, as reviewers see it: the head against its merge
 * base with the live base branch — the same view the web page, the API, and
 * review anchors all share, so a line means the same thing everywhere.
 */
export async function pullDiff(dir: string, pull: Pull): Promise<PullDiff> {
  const status = await pullStatus(dir, pull);
  const from =
    (await mergeBase(dir, status.baseOid, status.headOid)) ?? status.baseOid;
  const result = await diffRange(dir, from, status.headOid);
  const diff = result.ok
    ? result.value
    : { files: [], additions: 0, deletions: 0 };
  return { status, from, diff };
}

export interface PullStatus {
  /** Live base tip (may differ from the snapshot at creation). */
  readonly baseOid: string;
  readonly headOid: string;
  readonly ahead: number;
  readonly mergeable: boolean;
  readonly conflicts: string[];
}

/** Recompute mergeability against the live base. The head is the live branch
 * for a same-repo PR, or the snapshot in refs/pull/N/head for a cross-repo one
 * (the fork's tip lives in another repo; we compare against what we fetched). */
export async function pullStatus(dir: string, pull: Pull): Promise<PullStatus> {
  const baseOid =
    (await resolveOid(dir, `refs/heads/${pull.baseBranch}`)) ?? pull.baseOid;
  const headRef = pull.crossRepo
    ? `refs/pull/${pull.number}/head`
    : `refs/heads/${pull.headBranch}`;
  const headOid = (await resolveOid(dir, headRef)) ?? pull.headOid;
  const ahead = await aheadCount(dir, baseOid, headOid);
  if (ahead === 0) {
    return { baseOid, headOid, ahead, mergeable: false, conflicts: [] };
  }
  const check = await mergeable(dir, baseOid, headOid);
  if (check.ok)
    return { baseOid, headOid, ahead, mergeable: true, conflicts: [] };
  const conflicts = check.error.kind === "conflict" ? check.error.files : [];
  return { baseOid, headOid, ahead, mergeable: false, conflicts };
}

export type MergePullError = MergeError | "already_merged" | "closed";

export async function mergePull(
  db: Database,
  dir: string,
  pull: Pull,
  input: {
    strategy: MergeStrategy;
    message: string;
    actorId: string;
    author: { name: string; email: string };
  },
): Promise<Result<{ mergeOid: string }, MergePullError>> {
  if (pull.mergedAt !== null) return err("already_merged");
  if (pull.state === "closed") return err("closed");

  const status = await pullStatus(dir, pull);
  const landed = await merge(dir, {
    baseBranch: pull.baseBranch,
    baseOid: status.baseOid,
    headOid: status.headOid,
    strategy: input.strategy,
    message: input.message,
    author: input.author,
  });
  if (!landed.ok) return landed;

  const now = new Date().toISOString();
  const finalize = db.transaction(() => {
    db.query(
      "UPDATE pull SET merged_at = ?1, merged_oid = ?2, merged_by = ?3, base_oid = ?4, head_oid = ?5 WHERE issue_id = ?6",
    ).run(
      now,
      landed.value.mergeOid,
      input.actorId,
      status.baseOid,
      status.headOid,
      pull.id,
    );
    setIssueState(db, pull.id, "closed");
  });
  finalize();

  // The merge commit is kept reachable forever, independent of the base branch.
  await writeRef(dir, `refs/pull/${pull.number}/merged`, landed.value.mergeOid);
  return ok({ mergeOid: landed.value.mergeOid });
}

export { getIssueById };
