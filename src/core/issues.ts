/**
 * Conversations: issues (and, later, pull requests) share one table and one
 * per-repo number sequence, so #1..#N are unique across both — the way people
 * expect to cite them. Comments and labels attach to the shared row.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type IssueKind = "issue" | "pull";
export type IssueState = "open" | "closed";

export interface Issue {
  readonly id: string;
  readonly repoId: string;
  readonly number: number;
  readonly kind: IssueKind;
  readonly title: string;
  readonly body: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly state: IssueState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

interface IssueRow {
  id: string;
  repo_id: string;
  number: number;
  kind: IssueKind;
  title: string;
  body: string;
  author_id: string;
  author_name: string;
  state: IssueState;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

const SELECT = `
  SELECT issue.*, user.username AS author_name
  FROM issue JOIN user ON user.id = issue.author_id`;

function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    repoId: row.repo_id,
    number: row.number,
    kind: row.kind,
    title: row.title,
    body: row.body,
    authorId: row.author_id,
    authorName: row.author_name,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

/** Atomically hand out the next issue number for a repo. */
export function nextNumber(db: Database, repoId: string): number {
  const row = db
    .query<
      { issue_seq: number },
      [string]
    >("UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq")
    .get(repoId);
  if (!row) throw new Error(`no such repo: ${repoId}`);
  return row.issue_seq;
}

export interface CreateIssueInput {
  repoId: string;
  authorId: string;
  title: string;
  /** @default "" */
  body?: string;
  /** @default "issue" */
  kind?: IssueKind;
}

export function createIssue(
  db: Database,
  input: CreateIssueInput,
): Result<Issue, "empty_title"> {
  const title = input.title.trim();
  if (title === "") return err("empty_title");

  // Number allocation and insert in one transaction: a visible row always
  // has a number, and a number is never handed out without a row.
  const create = db.transaction(() => {
    const number = nextNumber(db, input.repoId);
    const issueId = id();
    db.query(
      `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).run(
      issueId,
      input.repoId,
      number,
      input.kind ?? "issue",
      title,
      input.body ?? "",
      input.authorId,
    );
    return issueId;
  });
  const issueId = create();
  return ok(getIssueById(db, issueId)!);
}

export function getIssue(
  db: Database,
  repoId: string,
  number: number,
): Issue | undefined {
  const row = db
    .query<
      IssueRow,
      [string, number]
    >(`${SELECT} WHERE issue.repo_id = ?1 AND issue.number = ?2`)
    .get(repoId, number);
  return row ? toIssue(row) : undefined;
}

export function getIssueById(db: Database, issueId: string): Issue | undefined {
  const row = db
    .query<IssueRow, [string]>(`${SELECT} WHERE issue.id = ?1`)
    .get(issueId);
  return row ? toIssue(row) : undefined;
}

export interface ListIssuesOptions {
  /** @default "open" */
  state?: IssueState | "all";
  /** @default "issue" */
  kind?: IssueKind;
}

export function listIssues(
  db: Database,
  repoId: string,
  options: ListIssuesOptions = {},
): Issue[] {
  const state = options.state ?? "open";
  const kind = options.kind ?? "issue";
  const params: (string | number)[] = [repoId, kind];
  let where = "issue.repo_id = ?1 AND issue.kind = ?2";
  if (state !== "all") {
    params.push(state);
    where += ` AND issue.state = ?${params.length}`;
  }
  const rows = db
    .query<
      IssueRow,
      (string | number)[]
    >(`${SELECT} WHERE ${where} ORDER BY issue.number DESC`)
    .all(...params);
  return rows.map(toIssue);
}

export function countIssues(
  db: Database,
  repoId: string,
  kind: IssueKind,
  state: IssueState,
): number {
  const row = db
    .query<
      { n: number },
      [string, IssueKind, IssueState]
    >("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = ?2 AND state = ?3")
    .get(repoId, kind, state);
  return row?.n ?? 0;
}

/** CAS the state. Returns the new issue, or undefined if it was already there. */
export function setIssueState(
  db: Database,
  issueId: string,
  state: IssueState,
): Issue | undefined {
  const now = new Date().toISOString();
  const closedAt = state === "closed" ? now : null;
  const changed = db
    .query(
      "UPDATE issue SET state = ?1, closed_at = ?2, updated_at = ?3 WHERE id = ?4 AND state != ?1",
    )
    .run(state, closedAt, now, issueId).changes;
  return changed > 0 ? getIssueById(db, issueId) : undefined;
}

// ---- comments ----

export interface Comment {
  readonly id: string;
  readonly issueId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: string;
}

export function addComment(
  db: Database,
  input: { issueId: string; authorId: string; body: string },
): Result<Comment, "empty_body"> {
  const body = input.body.trim();
  if (body === "") return err("empty_body");
  const commentId = id();
  const now = new Date().toISOString();
  const write = db.transaction(() => {
    db.query(
      "INSERT INTO comment (id, issue_id, author_id, body) VALUES (?1, ?2, ?3, ?4)",
    ).run(commentId, input.issueId, input.authorId, body);
    db.query("UPDATE issue SET updated_at = ?1 WHERE id = ?2").run(
      now,
      input.issueId,
    );
  });
  write();
  return ok(getComment(db, commentId)!);
}

function getComment(db: Database, commentId: string): Comment | undefined {
  const row = db
    .query<
      {
        id: string;
        issue_id: string;
        author_id: string;
        author_name: string;
        body: string;
        created_at: string;
      },
      [string]
    >(
      `SELECT comment.*, user.username AS author_name
       FROM comment JOIN user ON user.id = comment.author_id WHERE comment.id = ?1`,
    )
    .get(commentId);
  if (!row) return undefined;
  return {
    id: row.id,
    issueId: row.issue_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
  };
}

export function listComments(db: Database, issueId: string): Comment[] {
  const rows = db
    .query<
      {
        id: string;
        issue_id: string;
        author_id: string;
        author_name: string;
        body: string;
        created_at: string;
      },
      [string]
    >(
      `SELECT comment.*, user.username AS author_name
       FROM comment JOIN user ON user.id = comment.author_id
       WHERE comment.issue_id = ?1 ORDER BY comment.id`,
    )
    .all(issueId);
  return rows.map((row) => ({
    id: row.id,
    issueId: row.issue_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
  }));
}

// ---- labels ----

export interface Label {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export function createLabel(
  db: Database,
  repoId: string,
  name: string,
  color: string,
): Result<Label, "invalid" | "taken"> {
  const clean = name.trim();
  if (clean === "" || !/^[0-9a-fA-F]{6}$/.test(color)) return err("invalid");
  if (
    db
      .query(
        "SELECT 1 FROM label WHERE repo_id = ?1 AND name = ?2 COLLATE NOCASE",
      )
      .get(repoId, clean)
  ) {
    return err("taken");
  }
  const labelId = id();
  db.query(
    "INSERT INTO label (id, repo_id, name, color) VALUES (?1, ?2, ?3, ?4)",
  ).run(labelId, repoId, clean, color.toLowerCase());
  return ok({ id: labelId, name: clean, color: color.toLowerCase() });
}

export function listLabels(db: Database, repoId: string): Label[] {
  return db
    .query<
      Label,
      [string]
    >("SELECT id, name, color FROM label WHERE repo_id = ?1 ORDER BY name")
    .all(repoId);
}

export function setIssueLabels(
  db: Database,
  issueId: string,
  labelIds: string[],
): void {
  const write = db.transaction(() => {
    db.query("DELETE FROM issue_label WHERE issue_id = ?1").run(issueId);
    const insert = db.query(
      "INSERT OR IGNORE INTO issue_label (issue_id, label_id) VALUES (?1, ?2)",
    );
    for (const labelId of labelIds) insert.run(issueId, labelId);
  });
  write();
}

export function labelsFor(db: Database, issueId: string): Label[] {
  return db
    .query<Label, [string]>(
      `SELECT label.id, label.name, label.color FROM label
       JOIN issue_label ON issue_label.label_id = label.id
       WHERE issue_label.issue_id = ?1 ORDER BY label.name`,
    )
    .all(issueId);
}
