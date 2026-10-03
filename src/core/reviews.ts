/**
 * Review comments: a comment anchored to a line of a pull request's diff.
 * The anchor is (path, side, line) PLUS a hash of that line's content, so a
 * later force-push either finds the same content still there (re-anchored) or
 * marks the comment outdated — it never silently lands on the wrong line, the
 * gap Forgejo left open (#21113).
 */

import { MAX_BODY, type BodyError } from "./issues.ts";
import type { Database } from "bun:sqlite";
import type { Diff } from "../git/diff.ts";
import { sha256 } from "../kernel/hash.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type Side = "old" | "new";

export interface ReviewComment {
  readonly id: string;
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: string;
  readonly path: string;
  readonly line: number;
  readonly side: Side;
  readonly commitOid: string;
  readonly lineHash: string;
}

/** A stable short hash of a line's exact content, for re-anchoring. */
export function hashLine(content: string): string {
  return sha256(content).slice(0, 16);
}

export interface AddReviewInput {
  pullId: string;
  authorId: string;
  body: string;
  path: string;
  line: number;
  side: Side;
  commitOid: string;
  lineHash: string;
}

export function addReviewComment(
  db: Database,
  input: AddReviewInput,
): Result<ReviewComment, BodyError> {
  const body = input.body.trim();
  if (body === "") return err("empty_body");
  if (body.length > MAX_BODY) return err("body_too_long");
  const commentId = id();
  const now = new Date().toISOString();
  const write = db.transaction(() => {
    db.query(
      `INSERT INTO comment (id, issue_id, author_id, body, kind, path, line, side, commit_oid, line_hash)
       VALUES (?1, ?2, ?3, ?4, 'review', ?5, ?6, ?7, ?8, ?9)`,
    ).run(
      commentId,
      input.pullId,
      input.authorId,
      body,
      input.path,
      input.line,
      input.side,
      input.commitOid,
      input.lineHash,
    );
    db.query("UPDATE issue SET updated_at = ?1 WHERE id = ?2").run(
      now,
      input.pullId,
    );
  });
  write();
  return ok({
    id: commentId,
    authorName: "",
    body,
    createdAt: now,
    path: input.path,
    line: input.line,
    side: input.side,
    commitOid: input.commitOid,
    lineHash: input.lineHash,
  });
}

interface ReviewRow {
  id: string;
  author_name: string;
  body: string;
  created_at: string;
  path: string;
  line: number;
  side: Side;
  commit_oid: string;
  line_hash: string;
}

export function listReviewComments(
  db: Database,
  pullId: string,
): ReviewComment[] {
  const rows = db
    .query<ReviewRow, [string]>(
      `SELECT comment.id, user.username AS author_name, comment.body, comment.created_at,
              comment.path, comment.line, comment.side, comment.commit_oid, comment.line_hash
       FROM comment JOIN user ON user.id = comment.author_id
       WHERE comment.issue_id = ?1 AND comment.kind = 'review'
       ORDER BY comment.id`,
    )
    .all(pullId);
  return rows.map((r) => ({
    id: r.id,
    authorName: r.author_name,
    body: r.body,
    createdAt: r.created_at,
    path: r.path,
    line: r.line,
    side: r.side,
    commitOid: r.commit_oid,
    lineHash: r.line_hash,
  }));
}

/** Group review comments by their anchor key `path\0side\0line`. */
export function byAnchor(
  comments: ReviewComment[],
): Map<string, ReviewComment[]> {
  const map = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const key = `${c.path}\0${c.side}\0${c.line}`;
    const existing = map.get(key);
    if (existing) existing.push(c);
    else map.set(key, [c]);
  }
  return map;
}

export function anchorKey(path: string, side: Side, line: number): string {
  return `${path}\0${side}\0${line}`;
}

/**
 * The text at an anchor in a diff, or undefined if the diff has no such row.
 * A row is anchored on the side git shows it: deletions on the old side,
 * additions and context on the new — exactly what the diff viewer renders.
 */
export function anchorContent(
  diff: Diff,
  path: string,
  side: Side,
  line: number,
): string | undefined {
  const file = diff.files.find((f) => f.path === path);
  if (!file) return undefined;
  for (const hunk of file.hunks) {
    for (const row of hunk.lines) {
      const rowSide: Side = row.kind === "del" ? "old" : "new";
      if (rowSide !== side) continue;
      const number = side === "old" ? row.oldNumber : row.newNumber;
      if (number === line) return row.content;
    }
  }
  return undefined;
}

/** A review comment with the viewer-facing verdict on its anchor. */
export interface AnchoredReview extends ReviewComment {
  /** True when the line no longer reads as it did when the comment was made. */
  readonly outdated: boolean;
}

export function withOutdated(
  comments: ReviewComment[],
  diff: Diff,
): AnchoredReview[] {
  return comments.map((c) => {
    const current = anchorContent(diff, c.path, c.side, c.line);
    return {
      ...c,
      outdated: current === undefined || hashLine(current) !== c.lineHash,
    };
  });
}

// ---- review states: a verdict on the pull, not on a line ----

/**
 * What a reviewer said about the change as a whole. `commented` is the
 * verdict that carries no authority — a reader may leave one — and the other
 * two are a writer's.
 */
export type ReviewState = "approved" | "changes_requested" | "commented";

export interface Review {
  readonly id: string;
  readonly authorId: string;
  readonly authorName: string;
  /** The login on the origin, for a review imported from one. */
  readonly originAuthor: string | null;
  readonly state: ReviewState;
  readonly body: string;
  /** The head the verdict was passed on. A verdict on an older head is stale. */
  readonly commitOid: string;
  readonly createdAt: string;
}

export type SubmitReviewError = "body_too_long" | "invalid_state";

const STATES: readonly ReviewState[] = [
  "approved",
  "changes_requested",
  "commented",
];

export const isReviewState = (value: string): value is ReviewState =>
  (STATES as readonly string[]).includes(value);

export interface SubmitReviewInput {
  issueId: string;
  authorId: string;
  state: ReviewState;
  /** May be empty: an approval needs no words. */
  body?: string;
  commitOid: string;
  /** Set when the review came from an origin rather than from here. */
  originRemoteId?: string;
  originAuthor?: string;
  createdAt?: string;
}

/**
 * Record a verdict. Every submission is its own row — the history of who
 * said what, when, and against which commit is the whole value of the table,
 * and `latestReviewByAuthor` is what collapses it into "where do we stand".
 */
export function submitReview(
  db: Database,
  input: SubmitReviewInput,
): Result<Review, SubmitReviewError> {
  if (!isReviewState(input.state)) return err("invalid_state");
  const body = (input.body ?? "").trim();
  if (body.length > MAX_BODY) return err("body_too_long");
  const reviewId = id();
  const now = input.createdAt ?? new Date().toISOString();
  const write = db.transaction(() => {
    db.query(
      `INSERT INTO review (id, issue_id, author_id, state, body, commit_oid,
                           origin_remote_id, origin_author, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).run(
      reviewId,
      input.issueId,
      input.authorId,
      input.state,
      body,
      input.commitOid,
      input.originRemoteId ?? null,
      input.originAuthor ?? null,
      now,
    );
    db.query("UPDATE issue SET updated_at = ?1 WHERE id = ?2").run(
      new Date().toISOString(),
      input.issueId,
    );
  });
  write();
  return ok(getReview(db, reviewId)!);
}

interface ReviewRowRaw {
  id: string;
  author_id: string;
  author_name: string;
  origin_author: string | null;
  state: ReviewState;
  body: string;
  commit_oid: string;
  created_at: string;
}

const REVIEW_SELECT = `
  SELECT review.id, review.author_id, user.username AS author_name,
         review.origin_author, review.state, review.body, review.commit_oid,
         review.created_at
  FROM review JOIN user ON user.id = review.author_id`;

const toReview = (row: ReviewRowRaw): Review => ({
  id: row.id,
  authorId: row.author_id,
  authorName: row.author_name,
  originAuthor: row.origin_author,
  state: row.state,
  body: row.body,
  commitOid: row.commit_oid,
  createdAt: row.created_at,
});

export function getReview(db: Database, reviewId: string): Review | undefined {
  const row = db
    .query<ReviewRowRaw, [string]>(`${REVIEW_SELECT} WHERE review.id = ?1`)
    .get(reviewId);
  return row ? toReview(row) : undefined;
}

/** Every verdict on a pull, oldest first — the record, not the summary. */
export function listReviews(db: Database, issueId: string): Review[] {
  return db
    .query<
      ReviewRowRaw,
      [string]
    >(`${REVIEW_SELECT} WHERE review.issue_id = ?1 ORDER BY review.id`)
    .all(issueId)
    .map(toReview);
}

/**
 * Where each reviewer currently stands: their most recent verdict, keyed by
 * author. A reviewer who requested changes and later approved counts once,
 * as an approval — which is the only reading that lets a review be
 * withdrawn without a delete path.
 *
 * An imported review is keyed by its origin login rather than by the local
 * author id, because every imported row is attributed to the connecting
 * user (`origins/import.ts`) and collapsing five upstream reviewers into
 * one would turn five approvals into whichever arrived last.
 */
export function latestReviewByAuthor(
  db: Database,
  issueId: string,
): Map<string, Review> {
  const latest = new Map<string, Review>();
  for (const review of listReviews(db, issueId)) {
    latest.set(review.originAuthor ?? review.authorId, review);
  }
  return latest;
}

export interface ReviewSummary {
  /** Distinct reviewers whose current verdict approves *this* head. */
  readonly approvals: number;
  readonly changesRequested: number;
  readonly commented: number;
  /** Current verdicts passed on an older head — dismissed by the push. */
  readonly stale: number;
}

/**
 * The state of play at one head. A verdict is counted only when it was
 * passed on the commit that is now the head: a push after a review is new
 * code nobody has looked at, and treating an old approval as current is how
 * a review gate becomes decorative.
 */
export function reviewSummary(
  db: Database,
  issueId: string,
  headOid: string,
): ReviewSummary {
  const agents = agentVerdicts(db, issueId);
  let approvals = 0;
  let changesRequested = 0;
  let commented = 0;
  let stale = 0;
  for (const review of latestReviewByAuthor(db, issueId).values()) {
    if (review.commitOid !== headOid) {
      if (review.state !== "commented") stale++;
      continue;
    }
    const agent = agents.authors.get(review.authorId);
    // An agent's verdict is its role's, not its own: it stands only while
    // the agent is a reviewer on this crew, so one taken off the crew stops
    // gating the pulls it judged.
    if (agent !== undefined && !agent.reviewer) {
      commented++;
      continue;
    }
    // The crew's reviewer gets REVIEW_ROUNDS rounds of changes on a pull;
    // past them, what it still asks is advice, and the pull lands as it is.
    if (
      agent !== undefined &&
      review.state === "changes_requested" &&
      agents.earlierRounds(headOid) >= REVIEW_ROUNDS
    ) {
      commented++;
      continue;
    }
    if (review.state === "approved") approvals++;
    else if (review.state === "changes_requested") changesRequested++;
    else commented++;
  }
  return { approvals, changesRequested, commented, stale };
}

/** Rounds of changes the crew's reviewer may ask for on one pull: a round is a head it asked changes on. */
export const REVIEW_ROUNDS = 2;

/**
 * What the gate needs to know about the agents who passed verdicts on a
 * pull: whether each is a reviewer on the pull's crew now, and on how many
 * heads other than a given one an agent asked for changes.
 */
function agentVerdicts(
  db: Database,
  issueId: string,
): {
  authors: Map<string, { reviewer: boolean }>;
  earlierRounds: (headOid: string) => number;
} {
  const rows = db
    .query<
      { author_id: string; role: string | null; commit_oid: string; state: string },
      [string]
    >(
      `SELECT review.author_id, repo_crew.role, review.commit_oid, review.state
       FROM review
       JOIN issue ON issue.id = review.issue_id
       JOIN user ON user.id = review.author_id AND user.is_agent = 1
       LEFT JOIN repo_crew ON repo_crew.repo_id = issue.repo_id
                          AND repo_crew.user_id = review.author_id
       WHERE review.issue_id = ?1`,
    )
    .all(issueId);
  const authors = new Map(
    rows.map((r) => [r.author_id, { reviewer: r.role === "reviewer" }]),
  );
  const asked = new Set(
    rows.filter((r) => r.state === "changes_requested").map((r) => r.commit_oid),
  );
  return {
    authors,
    earlierRounds: (headOid) => [...asked].filter((oid) => oid !== headOid).length,
  };
}

// ---- threads ----

/**
 * The stable, URL-safe name of a thread: every review comment sharing one
 * (path, side, line) is one conversation, and this is what addresses it.
 * A digest rather than the joined key itself, because the key contains NUL
 * and a path, neither of which belongs in a URL segment.
 */
export function anchorId(path: string, side: Side, line: number): string {
  return sha256(anchorKey(path, side, line)).slice(0, 16);
}

export interface ThreadState {
  readonly anchor: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

/** Resolution state for every thread on a pull that has one, by anchor. */
export function threadStates(
  db: Database,
  issueId: string,
): Map<string, ThreadState> {
  const rows = db
    .query<
      { anchor: string; resolved_at: string | null; resolved_by: string | null },
      [string]
    >(
      `SELECT anchor, resolved_at, resolved_by FROM review_thread
       WHERE issue_id = ?1`,
    )
    .all(issueId);
  return new Map(
    rows.map((row) => [
      row.anchor,
      {
        anchor: row.anchor,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
      },
    ]),
  );
}

export function resolveThread(
  db: Database,
  issueId: string,
  anchor: string,
  userId: string,
): ThreadState {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO review_thread (issue_id, anchor, resolved_at, resolved_by)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (issue_id, anchor) DO UPDATE SET
       resolved_at = excluded.resolved_at, resolved_by = excluded.resolved_by`,
  ).run(issueId, anchor, now, userId);
  return { anchor, resolvedAt: now, resolvedBy: userId };
}

export function unresolveThread(
  db: Database,
  issueId: string,
  anchor: string,
): ThreadState {
  db.query(
    `INSERT INTO review_thread (issue_id, anchor, resolved_at, resolved_by)
     VALUES (?1, ?2, NULL, NULL)
     ON CONFLICT (issue_id, anchor) DO UPDATE SET
       resolved_at = NULL, resolved_by = NULL`,
  ).run(issueId, anchor);
  return { anchor, resolvedAt: null, resolvedBy: null };
}

/** The comments of one thread, in order — who may resolve it is read off this. */
export function threadComments(
  db: Database,
  issueId: string,
  anchor: string,
): ReviewComment[] {
  return listReviewComments(db, issueId).filter(
    (c) => anchorId(c.path, c.side, c.line) === anchor,
  );
}

/** The stored form of a review the origin just returned, by its origin id. */
export function getReviewByRemoteId(
  db: Database,
  issueId: string,
  remoteId: string,
): Review | undefined {
  const row = db
    .query<
      ReviewRowRaw,
      [string, string]
    >(`${REVIEW_SELECT} WHERE review.issue_id = ?1 AND review.origin_remote_id = ?2`)
    .get(issueId, remoteId);
  return row ? toReview(row) : undefined;
}
