/**
 * Pull requests: an issue (kind "pull") with a base and head branch. The
 * diff and the commits live in git; this row records intent and outcome. On
 * merge we write refs/pull/N/merged so the merge commit stays reachable
 * forever, even if the base branch is later deleted and gc runs — the gap
 * Forgejo left open (#30972).
 */

import { getRepoById } from "./repos.ts";
import { repoDir } from "../git/repos.ts";
import { sealedByNumber } from "./sealed.ts";
import type { Database } from "bun:sqlite";
import { diffRange, type Diff, type DiffLaps } from "../git/diff.ts";
import { isSafeRef } from "../git/guard.ts";
import { refTip } from "../git/read.ts";
import { combine, combinedTip } from "../git/combined.ts";
import { fromKeptFork } from "./landing_kind.ts";
import { readTips } from "../git/tips.ts";
import {
  aheadCount,
  contentOnBase,
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
  LIST_LIMIT_MAX,
  listIssues,
  setIssueState,
  type Issue,
  type ListIssuesOptions,
} from "./issues.ts";
import { reviewSummary } from "./reviews.ts";
import { checkStale, checksHold } from "../checks/stale.ts";
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
  /** The pull this one reverts, when it was opened by "Take it back". */
  readonly revertsPullId: string | null;
  /** The variant group this pull belongs to; null for an ordinary pull. */
  readonly variantGroup: string | null;
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
  reverts_issue_id: string | null;
  variant_group: string | null;
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
    revertsPullId: row.reverts_issue_id,
    variantGroup: row.variant_group,
  };
}

/**
 * The numbers of the other pulls in each given pull's variant group, in the
 * same repository, ascending. An ordinary pull (no group) has none.
 */
export function variantSiblings(
  db: Database,
  pulls: readonly Pull[],
): number[][] {
  const groups = [
    ...new Set(pulls.flatMap((p) => (p.variantGroup === null ? [] : [p.variantGroup]))),
  ];
  const members = new Map<string, number[]>();
  for (const group of groups) {
    const rows = db
      .query<{ repo_id: string; number: number }, [string]>(
        `SELECT i.repo_id, i.number FROM pull p JOIN issue i ON i.id = p.issue_id
          WHERE p.variant_group = ?1 ORDER BY i.number`,
      )
      .all(group);
    for (const r of rows) {
      const key = `${r.repo_id}\0${group}`;
      members.set(key, [...(members.get(key) ?? []), r.number]);
    }
  }
  return pulls.map((p) =>
    p.variantGroup === null
      ? []
      : (members.get(`${p.repoId}\0${p.variantGroup}`) ?? []).filter(
          (n) => n !== p.number,
        ),
  );
}

/** Every pull in one variant group of a repository, in any state, by number. */
export function variantMembers(
  db: Database,
  repoId: string,
  group: string,
): Pull[] {
  const issues = db
    .query<{ issue_id: string }, [string, string]>(
      `SELECT p.issue_id FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id = ?1 AND p.variant_group = ?2 ORDER BY i.number`,
    )
    .all(repoId, group)
    .flatMap((r) => getIssueById(db, r.issue_id) ?? []);
  return joinMany(db, issues);
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
  /** The issue id of the pull this one reverts ("Take it back"). */
  revertsIssueId?: string;
  /** The variant group the pull joins; absent for an ordinary pull. */
  variantGroup?: string;
  /**
   * Who opened it on another forge, and where (#9011): written with the
   * issue row, so the pull is a guest (`origins/guest.ts`) from its first
   * moment and nothing can start it with secrets before it is marked.
   */
  origin?: { author: string; htmlUrl: string };
}

/**
 * The one way to a pull's objects (#621). An ordinary pull's head is in its
 * base (`refs/heads/<branch>`, or `refs/pull/N/head` fetched from a fork),
 * so the base's directory answers every question about it. A sealed pull's
 * head never enters the base before it merges — the base is read by
 * everyone, by sha as well as by name — so it lives in the private
 * repository its crew works in (`repo.sealedFor`), with `refs/pull/N/head`
 * there too, and that repository answers instead: its base branch is moved
 * to the base's tip first, so the diff and the merge check are taken
 * against the base as it is now. The base's objects are already there: a
 * fork borrows them (`forkBareRepo`).
 */
export async function pullDir(
  db: Database,
  reposRoot: string,
  repo: { ownerName: string; name: string },
  pull: Pick<Pull, "sealed" | "crossRepo" | "headRepoId" | "baseBranch">,
): Promise<string> {
  const baseDir = repoDir(reposRoot, repo.ownerName, repo.name);
  if (!pull.sealed || !pull.crossRepo) return baseDir;
  const head = getRepoById(db, pull.headRepoId);
  if (head === undefined || head.sealedFor === null) return baseDir;
  const headDir = repoDir(reposRoot, head.ownerName, head.name);
  await followBase(baseDir, headDir, pull.baseBranch);
  return headDir;
}

/**
 * Where a run's commit is: its pull's objects (`pullDir`) when it is about
 * a pull, else the repository's own.
 */
export async function runDir(
  db: Database,
  reposRoot: string,
  repo: { id: string; ownerName: string; name: string },
  issueId: string | null | undefined,
): Promise<string> {
  const issue =
    issueId === null || issueId === undefined
      ? undefined
      : getIssueById(db, issueId);
  const pull =
    issue?.kind === "pull" ? getPull(db, repo.id, issue.number) : undefined;
  return pull === undefined
    ? repoDir(reposRoot, repo.ownerName, repo.name)
    : pullDir(db, reposRoot, repo, pull);
}

/** Move the sealed work's `branch` to the base's tip of it. */
async function followBase(
  baseDir: string,
  headDir: string,
  branch: string,
): Promise<void> {
  const tip = await resolveOid(baseDir, `refs/heads/${branch}`);
  if (tip !== undefined) await writeRef(headDir, `refs/heads/${branch}`, tip);
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

  // The fix for a sealed report is sealed with it (`sealed.ts`), and its
  // objects never enter the base before it merges (`pullDir`).
  const sealed = closesFromBody(input.body ?? "").some((n) =>
    sealedByNumber(db, input.repoId, n),
  );
  const keptApart =
    sealed &&
    crossRepo &&
    getRepoById(db, input.headRepoId!)?.sealedFor === input.repoId;
  // Same-repo: read the head from this repo. Cross-repo: fetch the fork's head
  // branch into the base repo (bringing its objects), and diff/merge in-base.
  // Sealed work: read it where it lives, against the base's tip.
  if (keptApart)
    await followBase(dir, input.headDir!, input.baseBranch);
  const at = keptApart ? input.headDir! : dir;
  const headOid = keptApart
    ? await resolveOid(at, `refs/heads/${input.headBranch}`)
    : crossRepo
      ? await fetchInto(dir, input.headDir!, `refs/heads/${input.headBranch}`)
      : await resolveOid(dir, `refs/heads/${input.headBranch}`);
  if (!headOid) return err("unknown_head");
  if ((await aheadCount(at, baseOid, headOid)) === 0)
    return err("nothing_to_merge");

  // The fix for a sealed report is sealed with it: its diff says where
  // the hole is (`sealed.ts`).
  const issue = createIssue(db, {
    repoId: input.repoId,
    authorId: input.authorId,
    title: input.title,
    body: input.body ?? "",
    kind: "pull",
    sealed,
  });
  if (!issue.ok) return err(issue.error);
  if (input.origin !== undefined)
    db.query("UPDATE issue SET origin_author = ?1, origin_html_url = ?2 WHERE id = ?3").run(
      input.origin.author,
      input.origin.htmlUrl,
      issue.value.id,
    );

  const headRepoId = input.headRepoId ?? input.repoId;
  db.query(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, reverts_issue_id, variant_group)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).run(
    issue.value.id,
    input.baseBranch,
    input.headBranch,
    baseOid,
    headOid,
    headRepoId,
    input.revertsIssueId ?? null,
    input.variantGroup ?? null,
  );

  // A durable, fetchable ref for the PR head — the way tooling addresses it,
  // and (for cross-repo) the only place the base repo holds the fork's tip.
  await writeRef(at, `refs/pull/${issue.value.number}/head`, headOid);

  const pull = join(db, issue.value)!;
  // A kept fork's pull is combined with main on our side (#9012).
  if (at === dir && fromKeptFork(db, pull))
    await combine(dir, { number: pull.number, baseOid, headOid });
  return ok(pull);
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
 * `pullForBranch` for many branches of one repository: each branch's newest
 * pull, in two queries per chunk. Branches with none are absent.
 */
export function pullsForBranches(
  db: Database,
  repoId: string,
  branches: readonly string[],
): Map<string, Pull> {
  const out = new Map<string, Pull>();
  const unique = [...new Set(branches)].filter((b) => b !== "");
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<{ id: string; branch: string }, string[]>(
        `SELECT issue.id AS id, pull.head_branch AS branch
           FROM pull JOIN issue ON issue.id = pull.issue_id
          WHERE issue.repo_id = ?1
            AND pull.head_branch IN (${batch.map((_, n) => `?${n + 2}`).join(",")})
          ORDER BY issue.created_at DESC`,
      )
      .all(repoId, ...batch);
    const newest = new Map<string, string>();
    for (const r of rows) if (!newest.has(r.branch)) newest.set(r.branch, r.id);
    const pulls = new Map(
      joinMany(db, [...getIssuesByIds(db, [...newest.values()]).values()]).map(
        (pull) => [pull.id, pull] as const,
      ),
    );
    for (const [branch, id] of newest) {
      const pull = pulls.get(id);
      if (pull !== undefined) out.set(branch, pull);
    }
  }
  return out;
}

/**
 * Bring a same-repo pull's stored head up to its branch's new tip. Every seam
 * that lands a commit on a branch — a git push, the web editor, the API —
 * calls this one function, so `pull.headOid` never names a commit the branch
 * has moved past. The cross-repo counterpart is `refreshPullHead`
 * (`core/following.ts`), which fetches from another repo; here the commit is
 * already local, so this is a plain write. Called before the landing is
 * announced on the bus, so no listener — a check, a deploy — can read the
 * row before it catches up.
 */
export function trackPullHead(
  db: Database,
  repoId: string,
  branch: string,
  newOid: string,
): void {
  const pull = pullForBranch(db, repoId, branch);
  if (
    pull === undefined ||
    pull.crossRepo ||
    pull.mergedAt !== null ||
    pull.state === "closed" ||
    pull.headOid === newOid
  )
    return;
  db.query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1").run(
    pull.id,
    newOid,
  );
}

/** Point an open same-repo pull at another branch of this repository, at its tip. */
export function retargetPull(
  db: Database,
  pullId: string,
  branch: string,
  headOid: string,
): void {
  db.query(
    "UPDATE pull SET head_branch = ?2, head_oid = ?3 WHERE issue_id = ?1",
  ).run(pullId, branch, headOid);
}

/**
 * The pull that already reverts this one, if taking it back has already
 * been done — open, or merged, either one counts as "already taken back".
 * A revert pull that was closed *without* merging is an abandoned attempt,
 * not a standing answer, so it does not block a second try.
 */
export function revertOf(
  db: Database,
  repoId: string,
  pullId: string,
): Pull | undefined {
  const row = db
    .query<
      { number: number },
      [string, string]
    >(`SELECT issue.number AS number FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE issue.repo_id = ?1 AND pull.reverts_issue_id = ?2
         AND (issue.state = 'open' OR pull.merged_at IS NOT NULL)
       ORDER BY issue.created_at DESC LIMIT 1`)
    .get(repoId, pullId);
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

/**
 * The one open pull into `baseRepoId` whose head is this branch of this
 * repository, asked of the database rather than found in a page of pulls.
 */
export function openPullFromHead(
  db: Database,
  baseRepoId: string,
  headRepoId: string,
  branch: string,
): Pull | undefined {
  const row = db
    .query<{ number: number }, [string, string, string]>(
      `SELECT issue.number FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE issue.repo_id = ?1 AND pull.head_repo_id = ?2 AND pull.head_branch = ?3
         AND issue.state = 'open'
       ORDER BY issue.number DESC LIMIT 1`,
    )
    .get(baseRepoId, headRepoId, branch);
  return row === null || row === undefined ? undefined : getPull(db, baseRepoId, row.number);
}

/**
 * The newest open pull of each repository, in one query — what a shelf row
 * shows when nothing about the app is moving otherwise: a change waits for
 * a look whether an agent opened it or a person did, and the row is about
 * the app, not about who typed it.
 */
export function openPullsForRepos(
  db: Database,
  repoIds: readonly string[],
): Map<string, Pull> {
  const out = new Map<string, Pull>();
  const unique = [...new Set(repoIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<{ issue_id: string }, string[]>(
        `SELECT issue_id FROM (
           SELECT pull.issue_id AS issue_id,
                  ROW_NUMBER() OVER (PARTITION BY issue.repo_id ORDER BY issue.created_at DESC) AS rn
           FROM pull JOIN issue ON issue.id = pull.issue_id
           WHERE issue.state = 'open' AND issue.repo_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})
         ) WHERE rn = 1`,
      )
      .all(...batch);
    const issues = getIssuesByIds(db, rows.map((r) => r.issue_id));
    for (const pull of joinMany(db, [...issues.values()])) out.set(pull.repoId, pull);
  }
  return out;
}

/** An open, unmerged pull as the pile lists it before it is hydrated. */
export interface PileRow {
  readonly id: string;
  readonly repoId: string;
  readonly sealed: boolean;
  readonly authorId: string;
}

/**
 * Every open, unmerged pull on the forge, oldest first, in one query: the
 * pile an MCP caller pages (#7655). Reading rights are the caller's to apply
 * to the rows (`canRead`, `mayView`); no git is touched.
 */
export function openPullPileRows(db: Database): PileRow[] {
  return db
    .query<{ id: string; repo_id: string; sealed: number; author_id: string }, []>(
      `SELECT issue.id, issue.repo_id, issue.sealed, issue.author_id
         FROM issue JOIN pull ON pull.issue_id = issue.id
        WHERE issue.state = 'open' AND pull.merged_at IS NULL
        ORDER BY issue.created_at, issue.id`,
    )
    .all()
    .map((r) => ({ id: r.id, repoId: r.repo_id, sealed: r.sealed === 1, authorId: r.author_id }));
}

/** These pulls by issue id, in the order asked. */
export function pullsByIssueIds(db: Database, ids: readonly string[]): Pull[] {
  const issues = getIssuesByIds(db, ids);
  return joinMany(db, ids.flatMap((id) => issues.get(id) ?? []));
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
 * Every open pull of the repository, sealed ones too, oldest first. All of
 * them, page by page: a pass that read only the newest page never saw an
 * older pull — the green sweep's approved ones (#4053), the finishing
 * pass's approved, conflicted ones (#6263).
 */
export function listOpenPulls(db: Database, repoId: string): Pull[] {
  const all: Pull[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = listPulls(db, repoId, {
      sealed: true,
      state: "open",
      limit: LIST_LIMIT_MAX,
      ...(cursor === undefined ? {} : { cursor }),
    });
    all.push(...page);
    if (page.length < LIST_LIMIT_MAX) break;
    cursor = page.at(-1)!.number;
  }
  return all.sort((a, b) => a.number - b.number);
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
  const { from, diff } = await diffBetween(dir, status.baseOid, status.headOid);
  return { status, from, diff };
}

/**
 * The diff of a head against its merge base with `baseOid`. `failed` says git
 * could not produce it, so the empty diff is a stand-in no one should keep.
 */
export async function diffBetween(
  dir: string,
  baseOid: string,
  headOid: string,
  laps?: DiffLaps,
): Promise<{ from: string; diff: Diff; failed: boolean }> {
  const started = performance.now();
  const from = (await mergeBase(dir, baseOid, headOid)) ?? baseOid;
  if (laps) laps.git = performance.now() - started;
  const result = await diffRange(dir, from, headOid, laps);
  return result.ok
    ? { from, diff: result.value, failed: false }
    : { from, diff: { files: [], additions: 0, deletions: 0 }, failed: true };
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
  const headRef = pull.crossRepo
    ? `refs/pull/${pull.number}/head`
    : `refs/heads/${pull.headBranch}`;
  // The tips come from the ref files (no process); git is asked only when
  // they cannot be read that way.
  const tip = async (ref: string): Promise<string | undefined> =>
    (await refTip(dir, ref)) ?? (await resolveOid(dir, ref));
  const [liveBase, liveHead] = await Promise.all([
    tip(`refs/heads/${pull.baseBranch}`),
    tip(headRef),
  ]);
  const baseOid = liveBase ?? pull.baseOid;
  const headOid = liveHead ?? pull.headOid;
  const reviews = gate === undefined ? null : reviewGate(gate, pull, headOid);
  // A fork's pull combined on our side merges as its combined branch (#9012).
  const lands = pull.crossRepo
    ? ((await combinedTip(dir, pull.number, headOid)) ?? headOid)
    : headOid;
  const { ahead, mergeable: clean, conflicts } = await mergeReading(
    dir,
    baseOid,
    lands,
  );
  return { baseOid, headOid, ahead, mergeable: clean, conflicts, reviews };
}

interface MergeReading {
  readonly ahead: number;
  readonly mergeable: boolean;
  readonly conflicts: string[];
}

/** The merge check a reading runs: git's merge-tree, or a test's stand-in. */
type MergeCheck = typeof mergeable;

/** Readings by `head:base` oid: a merge-tree over two commits never changes. */
const readings = new Map<string, MergeReading>();
const READINGS_MAX = 500;

async function mergeReading(
  dir: string,
  baseOid: string,
  headOid: string,
  check: MergeCheck = mergeable,
): Promise<MergeReading> {
  const key = `${headOid}:${baseOid}`;
  const known = readings.get(key);
  if (known !== undefined) return { ...known, conflicts: [...known.conflicts] };
  const ahead = await aheadCount(dir, baseOid, headOid);
  let reading: MergeReading;
  if (ahead === 0) reading = { ahead, mergeable: false, conflicts: [] };
  else {
    const merged = await check(dir, baseOid, headOid);
    reading = merged.ok
      ? { ahead, mergeable: true, conflicts: [] }
      : {
          ahead,
          mergeable: false,
          conflicts: merged.error.kind === "conflict" ? merged.error.files : [],
        };
    // A git failure is not a verdict about the commits: do not remember it.
    if (!merged.ok && merged.error.kind !== "conflict") return reading;
  }
  if (readings.size >= READINGS_MAX)
    readings.delete(readings.keys().next().value!);
  readings.set(key, reading);
  return { ...reading, conflicts: [...reading.conflicts] };
}

/**
 * Whether an open pull merges into its base's current head, and the paths
 * that stop it — what the API and the MCP say on every reading of a pull.
 * Null for a pull that is no longer open: there is nothing left to merge.
 */
export async function pullMergeState(
  dir: string,
  pull: Pull,
): Promise<{ mergeable: boolean; conflicts: string[] } | null> {
  if (pull.state !== "open" || pull.mergedAt !== null) return null;
  const { mergeable: clean, conflicts } = await pullStatus(dir, pull);
  return { mergeable: clean, conflicts };
}

/** How many merge readings run at once, across every list: never a fork bomb. */
const READ_AT_ONCE = 4;

/**
 * How long a list waits for readings it does not have (#8156). Every landing
 * moves the base and so invalidates every open pull's (head, base) pair; with
 * 47 pulls, four readings at a time, a list waited 71 s. Past this budget
 * the list answers what it knows and the readings finish in the background.
 */
export const MERGE_BUDGET_MS = 300;

/** Readings in flight by `dir:head:base`: one per pair, however many lists ask. */
const inflight = new Map<string, Promise<MergeReading>>();
const waiting: (() => Promise<void>)[] = [];
let running = 0;

function pump(): void {
  while (running < READ_AT_ONCE && waiting.length > 0) {
    const job = waiting.shift()!;
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

/** A reading of the pair, queued behind at most `READ_AT_ONCE` others. */
function readQueued(
  dir: string,
  baseOid: string,
  headOid: string,
  check: MergeCheck,
): Promise<MergeReading> {
  const key = `${dir}:${headOid}:${baseOid}`;
  const known = inflight.get(key);
  if (known !== undefined) return known;
  const reading = new Promise<MergeReading>((resolve, reject) => {
    waiting.push(() =>
      mergeReading(dir, baseOid, headOid, check).then(resolve, reject),
    );
  }).finally(() => inflight.delete(key));
  inflight.set(key, reading);
  pump();
  return reading;
}

/** Resolves when no reading is queued or running: for tests and shutdown. */
export async function mergeReadingsSettled(): Promise<void> {
  while (inflight.size > 0)
    await Promise.allSettled([...inflight.values()]);
}

/**
 * The last reading a list gave for a pull, by `dir:number`, and the head it
 * was for. Kept so a pull whose base moved answers what it said a moment ago
 * rather than nothing while its fresh reading runs.
 */
const lastByPull = new Map<string, { headOid: string; reading: MergeReading }>();

function remember(key: string, headOid: string, reading: MergeReading): void {
  lastByPull.delete(key);
  if (lastByPull.size >= READINGS_MAX)
    lastByPull.delete(lastByPull.keys().next().value!);
  lastByPull.set(key, { headOid, reading });
}

/**
 * `pullMergeState` for a page of pulls: tips read from the ref files (no git
 * process), each answer remembered by (base tip, head tip) in `mergeReading`
 * so git runs only for a pair that moved, at most `READ_AT_ONCE` readings in
 * flight, and at most one per pair.
 *
 * A list waits at most `budgetMs` for readings it has not got. A pair still
 * reading after that answers the pull's last reading when its head has not
 * moved — only the base moved, and what this head did against the base one
 * landing ago is the best guess there is — and null when the head moved or
 * the pull was never read: no reading of these commits exists, and a guess
 * about new commits would be invented. A stale `mergeable: true` misleads
 * nobody into a bad land: `mergePull` reads the pair afresh before it merges.
 * The reading carries on in the background, so the next list has it.
 */
export async function pullMergeStates(
  items: readonly { dir: string; pull: Pull }[],
  opts: { budgetMs?: number; check?: MergeCheck } = {},
): Promise<({ mergeable: boolean; conflicts: string[] } | null)[]> {
  const budgetMs = opts.budgetMs ?? MERGE_BUDGET_MS;
  const check = opts.check ?? mergeable;
  const out: ({ mergeable: boolean; conflicts: string[] } | null)[] =
    new Array(items.length).fill(null);
  const pending: Promise<void>[] = [];
  await Promise.all(
    items.map(async ({ dir, pull }, i) => {
      if (pull.state !== "open" || pull.mergedAt !== null) return;
      const baseRef = `refs/heads/${pull.baseBranch}`;
      const headRef = pull.crossRepo
        ? `refs/pull/${pull.number}/head`
        : `refs/heads/${pull.headBranch}`;
      const live = await readTips(dir, [baseRef, headRef]);
      const baseOid = live.get(baseRef) ?? pull.baseOid;
      const headOid = live.get(headRef) ?? pull.headOid;
      const pullKey = `${dir}:${pull.number}`;
      // A pair already read answers now, never queued behind slow ones.
      const known = readings.get(`${headOid}:${baseOid}`);
      if (known !== undefined) {
        remember(pullKey, headOid, known);
        out[i] = { mergeable: known.mergeable, conflicts: [...known.conflicts] };
        return;
      }
      const last = lastByPull.get(pullKey);
      if (last !== undefined && last.headOid === headOid)
        out[i] = { mergeable: last.reading.mergeable, conflicts: [...last.reading.conflicts] };
      pending.push(
        readQueued(dir, baseOid, headOid, check).then((r) => {
          remember(pullKey, headOid, r);
          out[i] = { mergeable: r.mergeable, conflicts: [...r.conflicts] };
        }),
      );
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  // An infinite budget waits for every reading (setTimeout would fire at once).
  const budget = Number.isFinite(budgetMs)
    ? new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      })
    : new Promise<void>(() => {});
  // A failed reading is answered by what the pull already holds.
  await Promise.race([Promise.allSettled(pending), budget]);
  clearTimeout(timer);
  // Copies: a reading that lands after the answer must not change it.
  return out.map((m) => (m === null ? null : { ...m, conflicts: [...m.conflicts] }));
}

/**
 * `mirrored` is a refusal, not a failure: on a mirrored repo the origin owns
 * the merge — its strategy, its protected branches, its required checks —
 * and a local merge would be overwritten by the next fetch. Merge there; the
 * next sync brings back the merge commit the origin actually made.
 */
/** One path a stranger may not change, and why, as a person reads it (`crew/stranger.ts`). */
export interface Guarded {
  readonly path: string;
  readonly why: string;
}

export type MergePullError =
  | MergeError
  /** A stranger's pull changes guarded paths: it does not land, whatever its review says (#9575). */
  | { readonly kind: "guarded"; readonly paths: readonly Guarded[] }
  | "already_merged"
  | "closed"
  /** The head moved after it was judged (`headOid`): nothing landed (#9575). */
  | "head_moved"
  | "mirrored"
  /** The repo requires an approval of this head, or a change was requested. */
  | "review_required"
  /** The repo requires a passing deploy of this head, and there is none yet. */
  | "checks_required";

/** The base a landing must find, and the tree it must write (#2036). */
export interface LandingExpect {
  readonly baseOid: string;
  readonly treeOid: string;
}

export async function mergePull(
  db: Database,
  dir: string,
  pull: Pull,
  input: {
    strategy: MergeStrategy;
    message: string;
    actorId: string;
    author: { name: string; email: string };
    /** Who commits it, when the author is the agent that wrote the change. */
    committer?: { name: string; email: string };
    /** The review gate. Absent means no review policy applies. */
    gate?: ReviewGate;
    /**
     * Where a sealed pull's work is (`pullDir`): asked first, there, and
     * brought into the base only to land — never before it may.
     */
    sealedFrom?: string;
    /**
     * What was judged (#2036): the base must still be at `baseOid` and the
     * merge must write `treeOid`, or nothing lands (`base_moved`).
     */
    expect?: LandingExpect;
    /**
     * The head that was judged (a stranger's guard, #9575): the head merged
     * must be this one, or nothing lands (`head_moved`). A fork can push
     * between the judging and the landing.
     */
    headOid?: string;
  },
): Promise<Result<{ mergeOid: string; carried: boolean }, MergePullError>> {
  // The row, not the caller's copy: a landing reads its pull, runs a gate
  // for minutes, then merges — and the pull may have landed meanwhile. A
  // stale copy merged again is an empty commit on the base (#2017).
  const issue = getIssueById(db, pull.id);
  const live = (issue?.kind === "pull" ? join(db, issue) : undefined) ?? pull;
  if (live.mergedAt !== null) return err("already_merged");
  if (live.state === "closed") return err("closed");

  if (input.sealedFrom !== undefined) {
    const there = await pullStatus(input.sealedFrom, pull, input.gate);
    if (there.reviews !== null && !there.reviews.mergeable)
      return err("review_required");
    if (
      input.gate?.requireChecks === true &&
      checkSummary(input.gate.db, pull.id, there.headOid).state !== "ok"
    )
      return err("checks_required");
    if (!there.mergeable)
      return err(
        there.conflicts.length > 0
          ? { kind: "conflict", files: there.conflicts }
          : { kind: "git", message: "nothing to merge" },
      );
    const tip = await fetchInto(
      dir,
      input.sealedFrom,
      `refs/pull/${pull.number}/head`,
    );
    if (tip === undefined)
      return err({ kind: "git", message: "the sealed work could not be read" });
    await writeRef(dir, `refs/pull/${pull.number}/head`, tip);
  }

  // The gate is read from the live head inside the merge, not passed in by a
  // caller: a check computed a request earlier and handed down is a check
  // that can be skipped.
  const status = await pullStatus(dir, pull, input.gate);
  if (input.expect !== undefined && status.baseOid !== input.expect.baseOid)
    return err({ kind: "base_moved" });
  if (input.headOid !== undefined && status.headOid !== input.headOid)
    return err("head_moved");
  // What the pull proposes is already on the base: there is nothing to
  // land, so nothing is committed — the pull closes as merged into the
  // commit that carried it, and the base does not move.
  const carrier = await carriedBy(dir, pull, status, input.strategy);
  if (carrier !== undefined) {
    closeAsMerged(db, pull.id, {
      mergeOid: carrier,
      actorId: input.actorId,
      baseOid: status.baseOid,
      headOid: status.headOid,
      carried: true,
    });
    return ok({ mergeOid: carrier, carried: true });
  }
  if (status.reviews !== null && !status.reviews.mergeable)
    return err("review_required");
  // The check is the latest deploy run of *this* head. Read here, not
  // handed in, for the same reason as the review verdict above. A landing
  // the merge queue gated (`expect`) is not held for a green on an older
  // base: the full tier ran on this very tree on this very base, which is
  // the proof a re-check would give (#3316). The head must still be green.
  if (input.gate !== undefined) {
    const check = checkSummary(input.gate.db, pull.id, status.headOid);
    if (
      checksHold(
        input.gate.requireChecks === true,
        check.state,
        input.expect === undefined && checkStale(check.run, status.baseOid),
      )
    )
      return err("checks_required");
  }
  // A kept fork lands its combined branch, brought up to the base first:
  // the author's head is its ancestor, so it lands too (#9012).
  const combined =
    input.sealedFrom === undefined && fromKeptFork(db, pull)
      ? await combine(dir, { number: pull.number, baseOid: status.baseOid, headOid: status.headOid })
      : undefined;
  const landed = await merge(dir, {
    baseBranch: pull.baseBranch,
    baseOid: status.baseOid,
    headOid: combined?.oid ?? status.headOid,
    strategy: input.strategy,
    message: input.message,
    author: input.author,
    ...(input.committer === undefined ? {} : { committer: input.committer }),
    ...(input.expect === undefined ? {} : { treeOid: input.expect.treeOid }),
  });
  if (!landed.ok) return landed;

  closeAsMerged(db, pull.id, {
    mergeOid: landed.value.mergeOid,
    actorId: input.actorId,
    baseOid: status.baseOid,
    headOid: status.headOid,
  });

  // The merge commit is kept reachable forever, independent of the base branch.
  await writeRef(dir, `refs/pull/${pull.number}/merged`, landed.value.mergeOid);
  return ok({ mergeOid: landed.value.mergeOid, carried: false });
}

/**
 * The commit on the base that already carries a squash of this pull, when
 * squashing it again would commit the base's own tree: the pull's own
 * landing if the base still holds it, else the base's tip. Undefined when
 * the squash would change something — or is not a squash, or does not
 * merge cleanly, which the merge itself reports.
 */
async function carriedBy(
  dir: string,
  pull: Pull,
  status: { baseOid: string; headOid: string; ahead: number; mergeable: boolean },
  strategy: MergeStrategy,
): Promise<string | undefined> {
  if (strategy !== "squash" || status.ahead === 0 || !status.mergeable)
    return undefined;
  if (!(await contentOnBase(dir, status.baseOid, status.headOid)))
    return undefined;
  const landing = await resolveOid(dir, `refs/pull/${pull.number}/merged`);
  if (
    landing !== undefined &&
    (await mergeBase(dir, landing, status.baseOid)) === landing
  )
    return landing;
  return status.baseOid;
}

/** Record the landing on the row and close the pull — once: a pull already
 * merged keeps the commit it first landed as. */
function closeAsMerged(
  db: Database,
  pullId: string,
  landed: {
    mergeOid: string;
    actorId: string;
    baseOid: string;
    headOid: string;
    carried?: boolean;
  },
): void {
  const now = new Date().toISOString();
  transact(db, () => {
    db.query(
      "UPDATE pull SET merged_at = ?1, merged_oid = ?2, merged_by = ?3, base_oid = ?4, head_oid = ?5, carried = ?7 WHERE issue_id = ?6 AND merged_at IS NULL",
    ).run(
      now,
      landed.mergeOid,
      landed.actorId,
      landed.baseOid,
      landed.headOid,
      pullId,
      landed.carried === true ? 1 : 0,
    );
    setIssueState(db, pullId, "closed");
  });
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
 * The newest merged pull whose description closes issue `number`: the pull
 * that shipped it. Undefined when it was closed by hand.
 */
export function mergedPullClosing(db: Database, repoId: string, number: number): Pull | undefined {
  const rows = db
    .query<{ number: number }, [string, string]>(
      `SELECT issue.number AS number FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE issue.repo_id = ?1 AND pull.merged_at IS NOT NULL AND issue.body LIKE ?2
       ORDER BY pull.merged_at DESC LIMIT 50`,
    )
    .all(repoId, `%#${number}%`);
  for (const row of rows) {
    const pull = getPull(db, repoId, row.number);
    if (pull !== undefined && closesFromBody(pull.body).includes(number)) return pull;
  }
  return undefined;
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
  for (const pull of listPulls(db, repoId, { sealed: true, state: "open", limit: 200 }))
    for (const n of closesFromBody(pull.body))
      if (!out.has(n)) out.set(n, pull);
  return out;
}

/**
 * The person whose words a pull answers: the author of the issue it closes
 * (or continues), when that is a person. Derived from the body and the issue
 * on every read — no column to drift. Null when it closes nothing, or only
 * work an agent filed.
 */
export function toldBy(db: Database, pull: Pull): string | null {
  for (const n of closesFromBody(pull.body)) {
    const issue = getIssue(db, pull.repoId, n);
    if (issue && !issue.authorIsAgent && issue.originAuthor === null)
      return issue.authorName;
  }
  return null;
}

/** A trailer value is one line: no control bytes, no angle brackets. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
}

/**
 * The trailers a landed change carries: who asked (`Requested-by`) and who
 * landed it (`Co-authored-by`), the agent being the commit's author.
 */
export function landingTrailers(
  requester: { name: string; email: string } | null,
  lander: { name: string; email: string },
): string {
  const line = (key: string, who: { name: string; email: string }) =>
    `${key}: ${oneLine(who.name)} <${oneLine(who.email)}>`;
  return [
    ...(requester ? [line("Requested-by", requester)] : []),
    line("Co-authored-by", lander),
  ].join("\n");
}

/**
 * Every pull of a repository merged at or after an instant, oldest merge
 * first — what a wave lists. Sealed reports' pulls are left out: a wave
 * is public text. `since` null means from the beginning.
 */
export function mergedPullsSince(
  db: Database,
  repoId: string,
  since: string | null,
): Pull[] {
  const ids = db
    .query<{ issue_id: string }, [string, string]>(
      `SELECT pull.issue_id FROM pull JOIN issue ON issue.id = pull.issue_id
       WHERE issue.repo_id = ?1 AND issue.sealed = 0
         AND pull.merged_at IS NOT NULL AND pull.merged_at >= ?2
       ORDER BY pull.merged_at ASC, issue.number ASC`,
    )
    .all(repoId, since ?? "")
    .map((r) => r.issue_id);
  const issues = getIssuesByIds(db, ids);
  return joinMany(
    db,
    ids.map((id) => issues.get(id)).filter((i): i is Issue => i !== undefined),
  );
}
