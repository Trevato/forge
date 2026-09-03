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
  /**
   * For an imported conversation: the login of whoever actually wrote it on
   * the origin. `authorId` stays the connecting user so every join and
   * permission check keeps working; this is what a surface renders instead,
   * with the origin's mark — an imported name must never be mistaken for a
   * local account.
   */
  readonly originAuthor: string | null;
  /** The canonical URL at the origin, for "view at source". */
  readonly originUrl: string | null;
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
  origin_author: string | null;
  origin_html_url: string | null;
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
    originAuthor: row.origin_author,
    originUrl: row.origin_html_url,
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

/** Caps on free text. Generous for humans, bounded for the index and the wire. */
export const MAX_TITLE = 256;
export const MAX_BODY = 65_536;

export type TitleError = "empty_title" | "title_too_long";
export type BodyError = "empty_body" | "body_too_long";

export function createIssue(
  db: Database,
  input: CreateIssueInput,
): Result<Issue, TitleError | "body_too_long"> {
  const title = input.title.trim();
  if (title === "") return err("empty_title");
  if (title.length > MAX_TITLE) return err("title_too_long");
  if ((input.body ?? "").length > MAX_BODY) return err("body_too_long");

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

export const LIST_LIMIT = 50;
export const LIST_LIMIT_MAX = 200;

export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Clamp a caller-supplied page size to [1, LIST_LIMIT_MAX]. */
export function pageLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(requested), 1), LIST_LIMIT_MAX);
}

export interface ListIssuesOptions {
  /** @default "open" */
  state?: IssueState | "all";
  /** @default "issue" */
  kind?: IssueKind;
  /** Only issues carrying this label (by name, case-insensitive, or id). */
  label?: string;
  /** Only issues opened by this username. */
  author?: string;
  /** Case-insensitive substring of the title — the list page's search box. */
  query?: string;
  /** Page size. @default LIST_LIMIT (max LIST_LIMIT_MAX) */
  limit?: number;
  /** Resume after this issue number (exclusive) — lists run newest first. */
  cursor?: number;
}

/**
 * Newest first, paged by issue number: a number is a stable, monotonic key,
 * so the cursor is simply the last number seen.
 */
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
  if (options.author !== undefined) {
    params.push(options.author);
    where += ` AND user.username = ?${params.length} COLLATE NOCASE`;
  }
  if (options.label !== undefined) {
    params.push(options.label);
    const p = params.length;
    where += ` AND EXISTS (
      SELECT 1 FROM issue_label JOIN label ON label.id = issue_label.label_id
      WHERE issue_label.issue_id = issue.id
        AND (label.id = ?${p} OR label.name = ?${p} COLLATE NOCASE))`;
  }
  if (options.query !== undefined && options.query.trim() !== "") {
    // LIKE with an escaped pattern: % and _ from a search box are literal
    // characters, not wildcards the user did not ask for.
    params.push(`%${likeEscape(options.query.trim())}%`);
    where += ` AND issue.title LIKE ?${params.length} ESCAPE '\\' COLLATE NOCASE`;
  }
  if (options.cursor !== undefined) {
    params.push(options.cursor);
    where += ` AND issue.number < ?${params.length}`;
  }
  params.push(pageLimit(options.limit));
  const rows = db
    .query<
      IssueRow,
      (string | number)[]
    >(`${SELECT} WHERE ${where} ORDER BY issue.number DESC LIMIT ?${params.length}`)
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
  /** The login on the origin, for an imported comment; null for a local one. */
  readonly originAuthor: string | null;
}

export function addComment(
  db: Database,
  input: { issueId: string; authorId: string; body: string },
): Result<Comment, BodyError> {
  const body = input.body.trim();
  if (body === "") return err("empty_body");
  if (body.length > MAX_BODY) return err("body_too_long");
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
        origin_author: string | null;
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
    originAuthor: row.origin_author,
  };
}

export interface ListCommentsOptions {
  /**
   * Which comments to return. A line-anchored review comment lives in the
   * same table as a conversation comment, so a pull request's conversation
   * asks for `"comment"` and its diff asks for the review ones — otherwise
   * the same remark shows up twice on one page. @default "all"
   */
  kind?: "comment" | "review" | "all";
}

export function listComments(
  db: Database,
  issueId: string,
  options: ListCommentsOptions = {},
): Comment[] {
  const kind = options.kind ?? "all";
  const where =
    kind === "all"
      ? "comment.issue_id = ?1"
      : `comment.issue_id = ?1 AND comment.kind = '${kind}'`;
  const rows = db
    .query<
      {
        id: string;
        issue_id: string;
        author_id: string;
        author_name: string;
        body: string;
        created_at: string;
        origin_author: string | null;
      },
      [string]
    >(
      `SELECT comment.*, user.username AS author_name
       FROM comment JOIN user ON user.id = comment.author_id
       WHERE ${where} ORDER BY comment.id`,
    )
    .all(issueId);
  return rows.map((row) => ({
    id: row.id,
    issueId: row.issue_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
    originAuthor: row.origin_author,
  }));
}

/**
 * How many conversation comments a thread carries. A list shows this beside
 * every row, so it is a count query, never `listComments(...).length`.
 */
export function countComments(db: Database, issueId: string): number {
  const row = db
    .query<
      { n: number },
      [string]
    >("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1 AND kind = 'comment'")
    .get(issueId);
  return row?.n ?? 0;
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

/**
 * Rename or recolor a label. The name stays unique per repo (case-insensitive)
 * and the color stays a validated hex, exactly as at creation.
 */
export function updateLabel(
  db: Database,
  repoId: string,
  labelId: string,
  name: string,
  color: string,
): Result<Label, "invalid" | "taken" | "not_found"> {
  const clean = name.trim();
  if (clean === "" || !/^[0-9a-fA-F]{6}$/.test(color)) return err("invalid");
  const current = db
    .query<
      Label,
      [string, string]
    >("SELECT id, name, color FROM label WHERE id = ?1 AND repo_id = ?2")
    .get(labelId, repoId);
  if (!current) return err("not_found");
  const clash = db
    .query(
      "SELECT 1 FROM label WHERE repo_id = ?1 AND name = ?2 COLLATE NOCASE AND id != ?3",
    )
    .get(repoId, clean, labelId);
  if (clash) return err("taken");
  db.query(
    "UPDATE label SET name = ?1, color = ?2 WHERE id = ?3 AND repo_id = ?4",
  ).run(clean, color.toLowerCase(), labelId, repoId);
  return ok({ id: labelId, name: clean, color: color.toLowerCase() });
}

/** A repo's label by id or by name (case-insensitive). */
export function getLabel(
  db: Database,
  repoId: string,
  idOrName: string,
): Label | undefined {
  return (
    db
      .query<
        Label,
        [string, string]
      >("SELECT id, name, color FROM label WHERE repo_id = ?1 AND (id = ?2 OR name = ?2 COLLATE NOCASE)")
      .get(repoId, idOrName) ?? undefined
  );
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

export function deleteLabel(
  db: Database,
  repoId: string,
  labelId: string,
): boolean {
  return (
    db
      .query("DELETE FROM label WHERE id = ?1 AND repo_id = ?2")
      .run(labelId, repoId).changes > 0
  );
}

/** How many ids one `IN (...)` carries; the rest come in further rounds. */
const GROUP_CHUNK = 500;

const holes = (n: number): string =>
  Array.from({ length: n }, (_, i) => `?${i + 1}`).join(",");

/**
 * Labels for a page of issues, in one grouped query — the shape a list must
 * use. `labelsFor` below is the singular, and calling it in a loop is the
 * N+1 this exists to replace.
 */
export function labelsForIssues(
  db: Database,
  issueIds: readonly string[],
): Map<string, Label[]> {
  const byIssue = new Map<string, Label[]>();
  for (const id of issueIds) byIssue.set(id, []);
  for (let i = 0; i < issueIds.length; i += GROUP_CHUNK) {
    const chunk = issueIds.slice(i, i + GROUP_CHUNK);
    if (chunk.length === 0) continue;
    const rows = db
      .query<Label & { issue_id: string }, string[]>(
        `SELECT issue_label.issue_id, label.id, label.name, label.color
         FROM label JOIN issue_label ON issue_label.label_id = label.id
         WHERE issue_label.issue_id IN (${holes(chunk.length)})
         ORDER BY label.name`,
      )
      .all(...chunk);
    for (const row of rows) {
      byIssue.get(row.issue_id)?.push({
        id: row.id,
        name: row.name,
        color: row.color,
      });
    }
  }
  return byIssue;
}

/** Conversation-comment counts for a page of issues, in one grouped query. */
export function commentCounts(
  db: Database,
  issueIds: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of issueIds) counts.set(id, 0);
  for (let i = 0; i < issueIds.length; i += GROUP_CHUNK) {
    const chunk = issueIds.slice(i, i + GROUP_CHUNK);
    if (chunk.length === 0) continue;
    const rows = db
      .query<{ issue_id: string; n: number }, string[]>(
        `SELECT issue_id, COUNT(*) AS n FROM comment
         WHERE kind = 'comment' AND issue_id IN (${holes(chunk.length)})
         GROUP BY issue_id`,
      )
      .all(...chunk);
    for (const row of rows) counts.set(row.issue_id, row.n);
  }
  return counts;
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
