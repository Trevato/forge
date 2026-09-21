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
import { transact } from "../kernel/db.ts";
import {
  createIssue,
  getIssue,
  getIssueById,
  getIssuesByIds,
  listIssues,
  setIssueState,
  type Issue,
  type ListIssuesOptions,
} from "./issues.ts";
import { reviewSummary } from "./reviews.ts";
import { checkSummary } from "./runs.ts";

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
  /**
   * For a mirrored pull whose head lives on the origin (often a fork we do
   * not hold): `owner/name` there. Null for a native pull.
   */
  readonly originHeadRepo: string | null;
}

interface PullRow {
  base_branch: string;
  head_branch: string;
  base_oid: string;
  head_oid: string;
  merged_at: string | null;
  merged_oid: string | null;
  head_repo_id: string | null;
  origin_head_repo: string | null;
}

function fromRow(issue: Issue, row: PullRow): Pull {
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
    originHeadRepo: row.origin_head_repo,
  };
}

function join(db: Database, issue: Issue): Pull | undefined {
  const row = db
    .query<PullRow, [string]>("SELECT * FROM pull WHERE issue_id = ?1")
    .get(issue.id);
  return row ? fromRow(issue, row) : undefined;
}

export type CreatePullError =
  | "empty_title"
  | "invalid_branch"
  | "same_branch"
  | "unknown_base"
  | "unknown_head"
  | "title_too_long"
  | "body_too_long"
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
  if (!issue.ok) return err(issue.error);

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

/**
 * The newest pull, in any state, whose head is this branch of this
 * repository — what an agent run's own `branch` names, and how
 * `landWork` (`crew/runner.ts`) finds the pull it already opened. A pull
 * is its own issue, unrelated in the schema to the issue that asked for
 * it; the branch is the only durable link a run's outcome leaves behind.
 */
export function pullForBranch(
  db: Database,
  repoId: string,
  branch: string,
): Pull | undefined {
  const row = db
    .query<
      { number: number },
      [string, string]
    >(`SELECT issue.number AS number FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE issue.repo_id = ?1 AND pull.head_branch = ?2
       ORDER BY issue.created_at DESC LIMIT 1`)
    .get(repoId, branch);
  return row ? getPull(db, repoId, row.number) : undefined;
}

/**
 * Open pulls, in any repository, whose head is this branch of this one:
 * what a push to a fork moves.
 */
export function listOpenPullsFromHead(
  db: Database,
  headRepoId: string,
  branch: string,
): Pull[] {
  const ids = db
    .query<{ issue_id: string }, [string, string]>(
      `SELECT pull.issue_id FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE pull.head_repo_id = ?1 AND pull.head_branch = ?2 AND issue.state = 'open'
       ORDER BY pull.issue_id`,
    )
    .all(headRepoId, branch)
    .map((r) => r.issue_id);
  return joinMany(db, [...getIssuesByIds(db, ids).values()]);
}

export type ListPullsOptions = Omit<ListIssuesOptions, "kind">;

export function listPulls(
  db: Database,
  repoId: string,
  options: ListPullsOptions = {},
): Pull[] {
  return joinMany(db, listIssues(db, repoId, { ...options, kind: "pull" }));
}

/**
 * Attach the pull rows to a page of issues in one query.
 *
 * The per-row `join` above is right for one pull and wrong for fifty: a list
 * of fifty pulls was fifty `SELECT * FROM pull WHERE issue_id = ?`, which is
 * fifty times the planner's fixed cost to fetch fifty tiny rows that a
 * single `IN` returns together. Issues that have no pull row are dropped, as
 * the per-row version already did.
 */
export function joinMany(db: Database, issues: readonly Issue[]): Pull[] {
  if (issues.length === 0) return [];
  const rows = new Map<string, PullRow & { issue_id: string }>();
  const CHUNK = 400;
  for (let i = 0; i < issues.length; i += CHUNK) {
    const batch = issues.slice(i, i + CHUNK);
    const found = db
      .query<
        PullRow & { issue_id: string },
        string[]
      >(`SELECT * FROM pull WHERE issue_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})`)
      .all(...batch.map((issue) => issue.id));
    for (const row of found) rows.set(row.issue_id, row);
  }
  const out: Pull[] = [];
  for (const issue of issues) {
    const row = rows.get(issue.id);
    if (row !== undefined) out.push(fromRow(issue, row));
  }
  return out;
}

/**
 * The newest merged pulls across several repositories, newest merge first
 * — what a wall of the crews' work shows as landed. One read over the
 * pull rows, then the issues they are.
 */
export function mergedPullsForRepos(
  db: Database,
  repoIds: readonly string[],
  limit = 12,
): Pull[] {
  const unique = [...new Set(repoIds)].slice(0, 400);
  if (unique.length === 0) return [];
  const ids = db
    .query<{ issue_id: string }, (string | number)[]>(
      `SELECT pull.issue_id FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE pull.merged_at IS NOT NULL
         AND issue.repo_id IN (${unique.map((_, n) => `?${n + 1}`).join(",")})
       ORDER BY pull.merged_at DESC LIMIT ?${unique.length + 1}`,
    )
    .all(...unique, Math.min(Math.max(limit, 1), 100))
    .map((r) => r.issue_id);
  const issues = getIssuesByIds(db, ids);
  return joinMany(
    db,
    ids.map((id) => issues.get(id)).filter((i): i is Issue => i !== undefined),
  );
}

/**
 * How many of a repository's pulls have landed since an instant — what
 * "shipped this week" counts, and what the cost of a shipped change
 * divides by. Counted by the database over the whole window, not off a
 * page of closed pulls: past a hundred of those the week under-reports,
 * and the cost per change reads high with nothing saying why.
 *
 * Closed is not shipped. A pull closed without a merge has no `merged_at`,
 * and `NULL >= anything` is `NULL` — never true, so it never counts; the
 * `IS NOT NULL` says so to the reader as well as the planner.
 */
export function mergedPullCount(
  db: Database,
  repoId: string,
  since: string,
): number {
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM issue JOIN pull ON pull.issue_id = issue.id
        WHERE issue.repo_id = ?1
          AND pull.merged_at IS NOT NULL AND pull.merged_at >= ?2`,
    )
    .get(repoId, since);
  return row?.n ?? 0;
}

/** The pull rows for a page of issues, keyed by issue id. */
export function pullsForIssues(
  db: Database,
  issues: readonly Issue[],
): Map<string, Pull> {
  return new Map(joinMany(db, issues).map((pull) => [pull.id, pull]));
}

/**
 * Which of these pull numbers have landed.
 *
 * A list of pulls renders a "merged" mark, and the summary shape a surface
 * gets from `RepoSource` cannot say — so the row was asked directly, once
 * per row. This is the same question for a whole page, addressed the way a
 * list has them: by number.
 */
export function mergedPullNumbers(
  db: Database,
  repoId: string,
  numbers: readonly number[],
): Set<number> {
  const out = new Set<number>();
  const unique = [...new Set(numbers)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<{ number: number }, (string | number)[]>(
        `SELECT issue.number FROM issue
         JOIN pull ON pull.issue_id = issue.id
         WHERE issue.repo_id = ?1 AND pull.merged_at IS NOT NULL
           AND issue.number IN (${batch.map((_, n) => `?${n + 2}`).join(",")})`,
      )
      .all(repoId, ...batch);
    for (const row of rows) out.add(row.number);
  }
  return out;
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
export async function pullDiff(
  dir: string,
  pull: Pull,
  gate?: ReviewGate,
): Promise<PullDiff> {
  const status = await pullStatus(dir, pull, gate);
  const from =
    (await mergeBase(dir, status.baseOid, status.headOid)) ?? status.baseOid;
  const result = await diffRange(dir, from, status.headOid);
  const diff = result.ok
    ? result.value
    : { files: [], additions: 0, deletions: 0 };
  return { status, from, diff };
}

/**
 * Where the review gate stands on this pull, at this head. `mergeable` here
 * is the *review* verdict alone — git may still refuse the merge — and it is
 * the same question `actions/pulls.ts` asks before landing anything.
 */
export interface PullReviewStatus {
  readonly approved: number;
  readonly changesRequested: number;
  /** Whether this repo demands an approval at all (`repo.requireReview`). */
  readonly required: boolean;
  readonly mergeable: boolean;
}

/**
 * What `pullStatus` needs to answer the review question: the index, and the
 * repo's setting. Optional because most callers want the git facts only,
 * and a status computed without it says `reviews: null` rather than
 * inventing a permissive answer.
 */
export interface ReviewGate {
  readonly db: Database;
  readonly requireReview: boolean;
  /**
   * Whether the head must also have a passing deploy run (`repo.requireChecks`).
   * Read live inside the merge like the review verdict. @default false
   */
  readonly requireChecks?: boolean;
}

export interface PullStatus {
  /** Live base tip (may differ from the snapshot at creation). */
  readonly baseOid: string;
  readonly headOid: string;
  readonly ahead: number;
  readonly mergeable: boolean;
  readonly conflicts: string[];
  /** Null when the caller did not pass a `ReviewGate` — never a guess. */
  readonly reviews: PullReviewStatus | null;
}

/**
 * The review verdict at one head: an approval of *this* commit and no
 * outstanding request for changes on it. A verdict passed on an earlier head
 * counts for nothing, in either direction — new code is new code.
 */
export function reviewGate(
  gate: ReviewGate,
  pull: Pull,
  headOid: string,
): PullReviewStatus {
  const summary = reviewSummary(gate.db, pull.id, headOid);
  return {
    approved: summary.approvals,
    changesRequested: summary.changesRequested,
    required: gate.requireReview,
    mergeable:
      summary.changesRequested === 0 &&
      (!gate.requireReview || summary.approvals > 0),
  };
}

/** Recompute mergeability against the live base. The head is the live branch
 * for a same-repo PR, or the snapshot in refs/pull/N/head for a cross-repo one
 * (the fork's tip lives in another repo; we compare against what we fetched). */
export async function pullStatus(
  dir: string,
  pull: Pull,
  gate?: ReviewGate,
): Promise<PullStatus> {
  const baseOid =
    (await resolveOid(dir, `refs/heads/${pull.baseBranch}`)) ?? pull.baseOid;
  const headRef = pull.crossRepo
    ? `refs/pull/${pull.number}/head`
    : `refs/heads/${pull.headBranch}`;
  const headOid = (await resolveOid(dir, headRef)) ?? pull.headOid;
  const reviews = gate === undefined ? null : reviewGate(gate, pull, headOid);
  const ahead = await aheadCount(dir, baseOid, headOid);
  if (ahead === 0) {
    return {
      baseOid,
      headOid,
      ahead,
      mergeable: false,
      conflicts: [],
      reviews,
    };
  }
  const check = await mergeable(dir, baseOid, headOid);
  if (check.ok)
    return {
      baseOid,
      headOid,
      ahead,
      mergeable: true,
      conflicts: [],
      reviews,
    };
  const conflicts = check.error.kind === "conflict" ? check.error.files : [];
  return { baseOid, headOid, ahead, mergeable: false, conflicts, reviews };
}

/**
 * `mirrored` is a refusal, not a failure: on a mirrored repo the origin owns
 * the merge — its strategy, its protected branches, its required checks —
 * and a local merge would be overwritten by the next fetch. Merge there; the
 * next sync brings back the merge commit the origin actually made.
 */
export type MergePullError =
  | MergeError
  | "already_merged"
  | "closed"
  | "mirrored"
  /** The repo requires an approval of this head, or a change was requested. */
  | "review_required"
  /** The repo requires a passing deploy of this head, and there is none yet. */
  | "checks_required";

export async function mergePull(
  db: Database,
  dir: string,
  pull: Pull,
  input: {
    strategy: MergeStrategy;
    message: string;
    actorId: string;
    author: { name: string; email: string };
    /** The review gate. Absent means no review policy applies. */
    gate?: ReviewGate;
  },
): Promise<Result<{ mergeOid: string }, MergePullError>> {
  if (pull.mergedAt !== null) return err("already_merged");
  if (pull.state === "closed") return err("closed");

  // The gate is read from the live head inside the merge, not passed in by a
  // caller: a check computed a request earlier and handed down is a check
  // that can be skipped.
  const status = await pullStatus(dir, pull, input.gate);
  if (status.reviews !== null && !status.reviews.mergeable)
    return err("review_required");
  // The check is the latest deploy run of *this* head. Read here, not
  // handed in, for the same reason as the review verdict above.
  if (
    input.gate?.requireChecks === true &&
    checkSummary(input.gate.db, pull.id, status.headOid).state !== "ok"
  )
    return err("checks_required");
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
  transact(db, () => {
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

  // The merge commit is kept reachable forever, independent of the base branch.
  await writeRef(dir, `refs/pull/${pull.number}/merged`, landed.value.mergeOid);
  return ok({ mergeOid: landed.value.mergeOid });
}

export { getIssueById };

// ---- what a pull says it closes ----

const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/** Issue numbers a pull's description closes: `Closes #12`, `Fixes #3`. */
export function closesFromBody(body: string): number[] {
  const out = new Set<number>();
  for (const m of body.matchAll(CLOSES)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

/**
 * Open pulls of a repository by the issue number each would close: the
 * work that is proposed and not yet landed, which is neither ready nor
 * done.
 */
export function openPullsClosing(
  db: Database,
  repoId: string,
): Map<number, Pull> {
  const out = new Map<number, Pull>();
  for (const pull of listPulls(db, repoId, { state: "open", limit: 200 }))
    for (const n of closesFromBody(pull.body))
      if (!out.has(n)) out.set(n, pull);
  return out;
}
