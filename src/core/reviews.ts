/**
 * Review comments: a comment anchored to a line of a pull request's diff.
 * The anchor is (path, side, line) PLUS a hash of that line's content, so a
 * later force-push either finds the same content still there (re-anchored) or
 * marks the comment outdated — it never silently lands on the wrong line, the
 * gap Forgejo left open (#21113).
 */

import type { Database } from "bun:sqlite";
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
): Result<ReviewComment, "empty_body"> {
  const body = input.body.trim();
  if (body === "") return err("empty_body");
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
