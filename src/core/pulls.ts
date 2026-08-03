/**
 * Pull requests: an issue (kind "pull") with a base and head branch. The
 * diff and the commits live in git; this row records intent and outcome. On
 * merge we write refs/pull/N/merged so the merge commit stays reachable
 * forever, even if the base branch is later deleted and gc runs — the gap
 * Forgejo left open (#30972).
 */

import type { Database } from "bun:sqlite";
import { isSafeRef } from "../git/guard.ts";
import {
  aheadCount,
  merge,
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
} from "./issues.ts";

export interface Pull extends Issue {
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly mergedAt: string | null;
  readonly mergedOid: string | null;
}

interface PullRow {
  base_branch: string;
  head_branch: string;
  base_oid: string;
  head_oid: string;
  merged_at: string | null;
  merged_oid: string | null;
}

function join(db: Database, issue: Issue): Pull | undefined {
  const row = db
    .query<PullRow, [string]>("SELECT * FROM pull WHERE issue_id = ?1")
    .get(issue.id);
  if (!row) return undefined;
  return {
    ...issue,
    baseBranch: row.base_branch,
    headBranch: row.head_branch,
    baseOid: row.base_oid,
    headOid: row.head_oid,
    mergedAt: row.merged_at,
    mergedOid: row.merged_oid,
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
  repoId: string;
  authorId: string;
  title: string;
  body?: string;
  baseBranch: string;
  headBranch: string;
}

export async function createPull(
  db: Database,
  dir: string,
  input: CreatePullInput,
): Promise<Result<Pull, CreatePullError>> {
  if (!isSafeRef(input.baseBranch) || !isSafeRef(input.headBranch))
    return err("invalid_branch");
  if (input.baseBranch === input.headBranch) return err("same_branch");

  const baseOid = await resolveOid(dir, `refs/heads/${input.baseBranch}`);
  if (!baseOid) return err("unknown_base");
  const headOid = await resolveOid(dir, `refs/heads/${input.headBranch}`);
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

  db.query(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).run(issue.value.id, input.baseBranch, input.headBranch, baseOid, headOid);

  // A durable, fetchable ref for the PR head — the way tooling addresses it.
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

export function listPulls(
  db: Database,
  repoId: string,
  state: "open" | "closed" | "all" = "open",
): Pull[] {
  return listIssues(db, repoId, { state, kind: "pull" })
    .map((issue) => join(db, issue))
    .filter((p): p is Pull => p !== undefined);
}

export interface PullStatus {
  /** Live base tip (may differ from the snapshot at creation). */
  readonly baseOid: string;
  readonly headOid: string;
  readonly ahead: number;
  readonly mergeable: boolean;
  readonly conflicts: string[];
}

/** Recompute mergeability against the live branches. */
export async function pullStatus(dir: string, pull: Pull): Promise<PullStatus> {
  const baseOid =
    (await resolveOid(dir, `refs/heads/${pull.baseBranch}`)) ?? pull.baseOid;
  const headOid =
    (await resolveOid(dir, `refs/heads/${pull.headBranch}`)) ?? pull.headOid;
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
