/**
 * Conversations: issues (and, later, pull requests) share one table and one
 * per-repo number sequence, so #1..#N are unique across both — the way people
 * expect to cite them. Comments and labels attach to the shared row.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { transact } from "../kernel/db.ts";
import { repoVisible } from "./visibility.ts";

export type IssueKind = "issue" | "pull";
export type IssueState = "open" | "closed";
/**
 * Why an issue closed: done frees what waited on it; the others hold it.
 * `parked` is the crew's own, on a pull it stopped for a person; it is never
 * one a request may name, so it is not in `CLOSE_REASONS`.
 */
export type CloseReason = "done" | "dropped" | "split" | "parked";
export const CLOSE_REASONS: readonly CloseReason[] = [
  "done",
  "dropped",
  "split",
];

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
  /** Why it closed; null while open, and for closes that predate reasons. */
  readonly closeReason: CloseReason | null;
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
  /**
   * Who is on it — one person or agent, or nobody. Assigning an agent is
   * what starts it working (docs/APPS.md), so this is a dispatch, not a
   * decoration.
   */
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  /** Whether the assignee is a crew member. */
  readonly assigneeIsAgent: boolean;
  /** Whether the author is a crew member, not a person. */
  readonly authorIsAgent: boolean;
  /**
   * A security report, or the pull that fixes one: seen only by people who
   * can write the repository and its crew until a writer unseals it
   * (`core/sealed.ts`).
   */
  readonly sealed: boolean;
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
  close_reason: CloseReason | null;
  parked: number;
  origin_author: string | null;
  origin_html_url: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_is_agent: number | null;
  author_is_agent: number;
  sealed: number;
}

const SELECT = `
  SELECT issue.*, user.username AS author_name, user.is_agent AS author_is_agent,
         assignee.username AS assignee_name, assignee.is_agent AS assignee_is_agent
  FROM issue JOIN user ON user.id = issue.author_id
  LEFT JOIN user AS assignee ON assignee.id = issue.assignee_id`;

/** `SELECT` without the body: a plan reads titles and states, and a body is most of a row's bytes. */
const SELECT_LEAN = SELECT.replace(
  "issue.*,",
  `issue.id, issue.repo_id, issue.number, issue.kind, issue.title, '' AS body, issue.author_id,
         issue.state, issue.created_at, issue.updated_at, issue.closed_at, issue.close_reason,
         issue.parked, issue.origin_author, issue.origin_html_url, issue.assignee_id, issue.sealed,`,
);

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
    closeReason: row.parked === 1 ? "parked" : row.close_reason,
    originAuthor: row.origin_author,
    originUrl: row.origin_html_url,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    assigneeIsAgent: row.assignee_is_agent === 1,
    authorIsAgent: row.author_is_agent === 1,
    sealed: row.sealed === 1,
  };
}

/**
 * Set or clear the assignee. Returns the issue as it now stands, or
 * undefined when it already stood that way — a no-op is not an event.
 */
export function setAssignee(
  db: Database,
  issueId: string,
  assigneeId: string | null,
): Issue | undefined {
  const changed = db
    .query(
      `UPDATE issue SET assignee_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1 AND assignee_id IS NOT ?2`,
    )
    .run(issueId, assigneeId).changes;
  return changed > 0 ? getIssueById(db, issueId) : undefined;
}

/**
 * Several conversations by id, in one query per chunk — what a run list
 * needs to name the pull each run is about without a read per row.
 */
export function getIssuesByIds(
  db: Database,
  issueIds: readonly string[],
): Map<string, Issue> {
  const out = new Map<string, Issue>();
  const unique = [...new Set(issueIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<
        IssueRow,
        string[]
      >(`${SELECT} WHERE issue.id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})`)
      .all(...batch);
    for (const row of rows) out.set(row.id, toIssue(row));
  }
  return out;
}

/**
 * Every conversation of one repository in one read, by id: cheaper than
 * `getIssuesByIds` once most of a repository is wanted.
 */
export function getIssuesOfRepo(
  db: Database,
  repoId: string,
  /** Only issues, or only pulls: a pull's body is the bulk of a repository's rows. */
  kind?: IssueKind,
  /** Leave the bodies empty: for a reader that never shows one. */
  lean = false,
): Map<string, Issue> {
  const out = new Map<string, Issue>();
  for (const row of db
    .query<IssueRow, [string, string]>(
      `${lean ? SELECT_LEAN : SELECT} WHERE issue.repo_id = ?1 AND (?2 = '' OR issue.kind = ?2)`,
    )
    .all(repoId, kind ?? ""))
    out.set(row.id, toIssue(row));
  return out;
}

/** The key `getIssuesByNumbers` files a conversation under. */
export const numberKey = (repoId: string, number: number): string =>
  `${repoId}#${number}`;

/**
 * Several conversations by repository and number, in one query per chunk —
 * what a feed of events (which name their subject by number) needs to title
 * each line without a read per event (#2675). Keyed by `numberKey`.
 */
export function getIssuesByNumbers(
  db: Database,
  refs: readonly { readonly repoId: string; readonly number: number }[],
): Map<string, Issue> {
  const out = new Map<string, Issue>();
  const unique = [
    ...new Map(refs.map((r) => [numberKey(r.repoId, r.number), r])).values(),
  ];
  const CHUNK = 200;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<IssueRow, (string | number)[]>(
        `${SELECT} WHERE (issue.repo_id, issue.number) IN (VALUES ${batch
          .map((_, n) => `(?${2 * n + 1}, ?${2 * n + 2})`)
          .join(",")})`,
      )
      .all(...batch.flatMap((r) => [r.repoId, r.number]));
    for (const row of rows) {
      const issue = toIssue(row);
      out.set(numberKey(issue.repoId, issue.number), issue);
    }
  }
  return out;
}

/**
 * Open pulls the crew has proposed, in repositories the viewer can see,
 * newest activity first — the "needs you" inbox, as one bounded query. The
 * caller narrows to repositories the viewer can *write* if it wants only
 * what they may merge; visibility is the part that must be in SQL.
 */
export function listOpenAgentPullsVisibleTo(
  db: Database,
  viewer: { id: string },
  limit = 25,
): Issue[] {
  return db
    .query<IssueRow, [string, number]>(
      `${SELECT} JOIN repo ON repo.id = issue.repo_id
       WHERE issue.kind = 'pull' AND issue.state = 'open' AND user.is_agent = 1
         AND ${repoVisible(true)}
       ORDER BY issue.updated_at DESC LIMIT ?2`,
    )
    .all(viewer.id, Math.min(Math.max(limit, 1), 200))
    .map(toIssue);
}

/**
 * Open pulls in repositories the viewer can see, newest activity first —
 * whoever opened them. The same query as `listOpenAgentPullsVisibleTo`
 * without the crew-only filter, for a surface that judges a change by what
 * it does rather than by who typed it (the studio's asks panel, the board,
 * a change's own Decide card). Autonomy code keeps reading the agent-only
 * list above: what a person is *shown* here must never widen what the crew
 * is left to decide on its own.
 */
export function listOpenPullsVisibleTo(
  db: Database,
  viewer: { id: string },
  limit = 25,
): Issue[] {
  return db
    .query<IssueRow, [string, number]>(
      `${SELECT} JOIN repo ON repo.id = issue.repo_id
       WHERE issue.kind = 'pull' AND issue.state = 'open'
         AND ${repoVisible(true)}
       ORDER BY issue.updated_at DESC LIMIT ?2`,
    )
    .all(viewer.id, Math.min(Math.max(limit, 1), 200))
    .map(toIssue);
}

/**
 * Open conversations assigned to one account, across every repository —
 * the "on you" list. An assignee can always see what is assigned to them:
 * assigning needs write access, and write implies read.
 */
export function listAssignedTo(
  db: Database,
  userId: string,
  limit = 50,
): Issue[] {
  return db
    .query<
      IssueRow,
      [string, number]
    >(`${SELECT} WHERE issue.assignee_id = ?1 AND issue.state = 'open' ORDER BY issue.updated_at DESC LIMIT ?2`)
    .all(userId, limit)
    .map(toIssue);
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
  /** A security report, seen only by writers and the crew (`sealed.ts`). @default false */
  sealed?: boolean;
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
  // has a number, and a number is never handed out without a row. Through
  // `transact`, so the transaction takes its write lock up front and a burst
  // of agents opening issues at once queues instead of colliding — fifty
  // callers must get fifty consecutive numbers, not a `SQLITE_BUSY`.
  const issueId = transact(db, () => {
    const number = nextNumber(db, input.repoId);
    const newId = id();
    db.query(
      `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, sealed)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).run(
      newId,
      input.repoId,
      number,
      input.kind ?? "issue",
      title,
      input.body ?? "",
      input.authorId,
      input.sealed === true ? 1 : 0,
    );
    return newId;
  });
  return ok(getIssueById(db, issueId)!);
}

/**
 * Whether a person's ask stands in this issue: a person wrote it (or it
 * came from an origin, under a name no account here holds), or it was named
 * in the `into` of a split that closed an issue a person's ask stood in. The
 * chain is followed, so splitting twice does not make an ask the crew's.
 * Read from the `issue.closed` events, which are the one record of a split.
 */
export function standsForPerson(
  db: Database,
  issue: Issue,
  seen: Set<string> = new Set(),
): boolean {
  if (!issue.authorIsAgent || issue.originAuthor !== null) return true;
  seen.add(issue.id);
  const parents = db
    .query<{ number: number }, [string, number]>(
      `SELECT json_extract(payload, '$.number') AS number FROM event
        WHERE repo_id = ?1 AND kind = 'issue.closed'
          AND json_extract(payload, '$.reason') = 'split'
          AND EXISTS (
            SELECT 1 FROM json_each(json_extract(payload, '$.into'))
             WHERE value = ?2)`,
    )
    .all(issue.repoId, issue.number);
  for (const row of parents) {
    const parent = getIssue(db, issue.repoId, row.number);
    if (parent === undefined || seen.has(parent.id)) continue;
    if (standsForPerson(db, parent, seen)) return true;
  }
  return false;
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
  /** Only issues assigned to this username. */
  assignee?: string;
  /** Case-insensitive substring of the title — the list page's search box. */
  query?: string;
  /** Page size. @default LIST_LIMIT (max LIST_LIMIT_MAX) */
  limit?: number;
  /** Resume after this issue number (exclusive) — lists run newest first. */
  cursor?: number;
  /**
   * Include sealed issues (`sealed.ts`): only for a viewer who may see them,
   * or the forge's own work. Left out unless asked for, so a list that
   * forgets shows nothing sealed.
   */
  sealed?: boolean;
  /** Include the sealed issues this user filed (`sealed.ts`): a reporter follows their own report. */
  sealedBy?: string;
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
  if (options.sealed !== true) {
    if (options.sealedBy === undefined) where += " AND issue.sealed = 0";
    else {
      params.push(options.sealedBy);
      where += ` AND (issue.sealed = 0 OR issue.author_id = ?${params.length})`;
    }
  }
  if (state !== "all") {
    params.push(state);
    where += ` AND issue.state = ?${params.length}`;
  }
  if (options.author !== undefined) {
    params.push(options.author);
    where += ` AND user.username = ?${params.length} COLLATE NOCASE`;
  }
  if (options.assignee !== undefined) {
    params.push(options.assignee);
    where += ` AND assignee.username = ?${params.length} COLLATE NOCASE`;
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
  reason: CloseReason = "done",
): Issue | undefined {
  const now = new Date().toISOString();
  const closedAt = state === "closed" ? now : null;
  const why = state === "closed" && reason !== "parked" ? reason : null;
  const parked = state === "closed" && reason === "parked" ? 1 : 0;
  const changed = db
    .query(
      `UPDATE issue SET state = ?1, closed_at = ?2, updated_at = ?3,
         close_reason = ?5, parked = ?6
       WHERE id = ?4 AND state != ?1`,
    )
    .run(state, closedAt, now, issueId, why, parked).changes;
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
  /**
   * The run this was said into while it worked (`steerRun`), once that run
   * ended well: its agent heard it and acted, so no later run is told it
   * again (`crew/news.ts`). Null while the run works, and for good when it
   * failed or was cut short — handed to a session that never answered is
   * not heard, and the word is news to the next run.
   */
  readonly heardIn: string | null;
}

/** Record that run `runId` heard comment `commentId` as it worked. */
export function markHeard(db: Database, commentId: string, runId: string): void {
  db.query("UPDATE comment SET heard_in = ?2 WHERE id = ?1").run(commentId, runId);
}

/**
 * New words for an issue or a pull: the title, the body, or both. The same
 * caps as opening. Touches `updated_at`, as a comment does: an edit is
 * someone attending to it.
 */
export function updateIssueText(
  db: Database,
  issueId: string,
  input: { title?: string | undefined; body?: string | undefined },
): Result<Issue, TitleError | "body_too_long" | "not_found"> {
  const before = getIssueById(db, issueId);
  if (before === undefined) return err("not_found");
  const title = input.title === undefined ? before.title : input.title.trim();
  if (title === "") return err("empty_title");
  if (title.length > MAX_TITLE) return err("title_too_long");
  const body = input.body ?? before.body;
  if (body.length > MAX_BODY) return err("body_too_long");
  db.query(
    "UPDATE issue SET title = ?1, body = ?2, updated_at = ?3 WHERE id = ?4",
  ).run(title, body, new Date().toISOString(), issueId);
  return ok(getIssueById(db, issueId)!);
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
  transact(db, () => {
    db.query(
      "INSERT INTO comment (id, issue_id, author_id, body) VALUES (?1, ?2, ?3, ?4)",
    ).run(commentId, input.issueId, input.authorId, body);
    db.query("UPDATE issue SET updated_at = ?1 WHERE id = ?2").run(
      now,
      input.issueId,
    );
  });
  return ok(getComment(db, commentId)!);
}

/**
 * A thank-you note (#9013) for this landing already stands on the pull: one
 * written by the person who landed it, naming the landing commit. Keyed on
 * its author, so a note anyone else posts cannot stand in for it.
 */
export function landingThanked(
  db: Database,
  input: { pullId: string; authorId: string; mergeOid: string },
): boolean {
  return (
    db
      .query<{ n: number }, [string, string, string]>(
        "SELECT count(*) AS n FROM comment WHERE issue_id = ?1 AND author_id = ?2 AND body LIKE 'Thank you, %' AND instr(body, ?3) > 0",
      )
      .get(input.pullId, input.authorId, input.mergeOid.slice(0, 12))!.n > 0
  );
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
        heard_ok: string | null;
      },
      [string]
    >(
      `SELECT comment.*, user.username AS author_name, heard.id AS heard_ok
       FROM comment JOIN user ON user.id = comment.author_id
       LEFT JOIN run heard ON heard.id = comment.heard_in AND heard.state = 'ok'
       WHERE comment.id = ?1`,
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
    heardIn: row.heard_ok,
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
  /** Only comments after this id (ids sort oldest first). */
  after?: string;
  /** Only comments before this id. */
  before?: string;
  /** With `limit`: the newest ones, still answered oldest first. */
  newest?: boolean;
  /** At most this many. */
  limit?: number;
}

/** How many of a thread's newest comments an issue read embeds, on the API and in the MCP (#6198). */
export const EMBEDDED_COMMENTS = 50;

/** How many timeline items a thread page shows before it folds the earlier ones behind `?all=1`. */
export const THREAD_WINDOW = 50;

/**
 * Where a comment's own anchor lands on its thread page: `#c-<id>` when it
 * is among the newest comments the page shows, `?all=1#c-<id>` when it is
 * folded away. One COUNT, not the whole thread. The page cuts its window on
 * comments too (`conversation()`, web/pages/thread.ts): the newest
 * THREAD_WINDOW comments, with the state lines between them riding along.
 * Both count the same thing, so the anchor always lands.
 */
export function commentAnchor(db: Database, issueId: string, commentId: string): string {
  const after = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1 AND kind = 'comment' AND id > ?2",
    )
    .get(issueId, commentId)!.n;
  return `${after >= THREAD_WINDOW ? "?all=1" : ""}#c-${commentId}`;
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
  const args: string[] = [issueId];
  let range = "";
  if (options.after !== undefined) range += ` AND comment.id > ?${args.push(options.after)}`;
  if (options.before !== undefined) range += ` AND comment.id < ?${args.push(options.before)}`;
  const newest = options.newest === true && options.limit !== undefined;
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
        heard_ok: string | null;
      },
      string[]
    >(
      `SELECT comment.*, user.username AS author_name, heard.id AS heard_ok
       FROM comment JOIN user ON user.id = comment.author_id
       LEFT JOIN run heard ON heard.id = comment.heard_in AND heard.state = 'ok'
       WHERE ${where}${range}
       ORDER BY comment.id${newest ? " DESC" : ""}${options.limit === undefined ? "" : ` LIMIT ${Math.trunc(options.limit)}`}`,
    )
    .all(...args);
  if (newest) rows.reverse();
  return rows.map((row) => ({
    id: row.id,
    issueId: row.issue_id,
    authorId: row.author_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
    originAuthor: row.origin_author,
    heardIn: row.heard_ok,
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

/** Every comment a thread holds, review lines included: what the API's `commentsTotal` says. */
export function countThread(db: Database, issueId: string): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1")
      .get(issueId)?.n ?? 0
  );
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

/**
 * How many open issues and pulls carry each label of a repository, in one
 * grouped query. A label with none has no entry. Sealed items are counted:
 * the caller is the admin-only labels page (and the delete confirm, gated on
 * write), and a writer sees sealed issues under `sealedScope` anyway.
 */
export function openLabelCounts(
  db: Database,
  repoId: string,
): Map<string, number> {
  const rows = db
    .query<{ label_id: string; n: number }, [string]>(
      `SELECT il.label_id, COUNT(*) AS n
       FROM label l
       JOIN issue_label il ON il.label_id = l.id
       JOIN issue i ON i.id = il.issue_id AND i.state = 'open'
       WHERE l.repo_id = ?1
       GROUP BY il.label_id`,
    )
    .all(repoId);
  return new Map(rows.map((r) => [r.label_id, r.n]));
}

/** The repository's labels, each with `open` (its open count) when `withCounts`. */
export function labelsWithOpen(
  db: Database,
  repoId: string,
  withCounts: boolean,
): Array<Label & { open?: number }> {
  const rows = listLabels(db, repoId);
  if (!withCounts) return rows;
  const counts = openLabelCounts(db, repoId);
  return rows.map((l) => ({ ...l, open: counts.get(l.id) ?? 0 }));
}

export function setIssueLabels(
  db: Database,
  issueId: string,
  labelIds: string[],
): void {
  transact(db, () => {
    db.query("DELETE FROM issue_label WHERE issue_id = ?1").run(issueId);
    const insert = db.query(
      "INSERT OR IGNORE INTO issue_label (issue_id, label_id) VALUES (?1, ?2)",
    );
    for (const labelId of labelIds) insert.run(issueId, labelId);
  });
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
  // Only ids with rows get an entry: an absent id is absent, never a phantom.
  const byIssue = new Map<string, Label[]>();
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
      const list = byIssue.get(row.issue_id) ?? [];
      list.push({ id: row.id, name: row.name, color: row.color });
      byIssue.set(row.issue_id, list);
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

// ---- grouped reads: one query for a page, not one query per row ----
//
// A list page asks the same question of fifty rows. Asked one row at a time
// that is fifty round trips through the query planner, and it is fifty at
// ten rows and fifty at ten thousand — the cost does not show up in a
// benchmark of one page, it shows up as a forge that got slower and nobody
// can say when. These are the same answers, asked once.
//
// SQLite takes 999 bound parameters by default, so every one of these
// chunks. Fifty-row pages never reach the boundary; a sync importing four
// thousand issues does.

const CHUNK = 400;

const chunked = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK)
    out.push(items.slice(i, i + CHUNK));
  return out;
};

/**
 * Open and closed counts for one repo and kind, in a single pass over the
 * covering index — the pair every list page shows above its tabs, which was
 * two full count queries.
 */
export function issueCounts(
  db: Database,
  repoId: string,
  kind: IssueKind,
): { open: number; closed: number } {
  const rows = db
    .query<
      { state: IssueState; n: number },
      [string, IssueKind]
    >(
      // Sealed reports are not counted where everyone reads the counts (`sealed.ts`).
      "SELECT state, COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = ?2 AND sealed = 0 GROUP BY state",
    )
    .all(repoId, kind);
  let open = 0;
  let closed = 0;
  for (const row of rows) {
    if (row.state === "closed") closed = row.n;
    else open = row.n;
  }
  return { open, closed };
}

/**
 * Which of these repositories have an open tell nobody holds — no assignee,
 * and not the repository's own standing direction issue, which is never
 * picked up like an ordinary tell. The shelf's one batched read for that
 * question, paired with `reposWithBuilder` (core/agents.ts) to say whether
 * it is stuck for want of a builder, not merely unclaimed for a moment.
 */
export function reposWithUnclaimedTell(
  db: Database,
  repoIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  const unique = [...new Set(repoIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<{ repo_id: string }, string[]>(
        `SELECT DISTINCT issue.repo_id FROM issue
         JOIN repo ON repo.id = issue.repo_id
         WHERE issue.kind = 'issue' AND issue.state = 'open'
           AND issue.assignee_id IS NULL
           AND (repo.direction_issue_id IS NULL OR repo.direction_issue_id != issue.id)
           AND issue.repo_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})`,
      )
      .all(...batch);
    for (const row of rows) out.add(row.repo_id);
  }
  return out;
}

/** Issues addressed the way an activity feed has them: by repo and number. */
export function getIssuesByRef(
  db: Database,
  refs: readonly { repoId: string; number: number }[],
): Map<string, Issue> {
  const out = new Map<string, Issue>();
  if (refs.length === 0) return out;
  // Grouped by repo: one query per repo touched, not one per event. A feed
  // spans a handful of repos however many events it shows.
  const byRepo = new Map<string, number[]>();
  for (const ref of refs) {
    const list = byRepo.get(ref.repoId);
    if (list === undefined) byRepo.set(ref.repoId, [ref.number]);
    else list.push(ref.number);
  }
  for (const [repoId, numbers] of byRepo) {
    for (const batch of chunked(numbers)) {
      const rows = db
        .query<IssueRow, (string | number)[]>(
          `${SELECT} WHERE issue.repo_id = ?1
           AND issue.number IN (${batch.map((_, i) => `?${i + 2}`).join(",")})`,
        )
        .all(repoId, ...batch);
      for (const row of rows) out.set(`${repoId}#${row.number}`, toIssue(row));
    }
  }
  return out;
}

/** The key `getIssuesByRef` uses, so callers never have to guess it. */
export const issueRefKey = (repoId: string, number: number): string =>
  `${repoId}#${number}`;

export interface IssueHit extends Issue {
  readonly ownerName: string;
  readonly repoName: string;
}

/**
 * Titles matching `query`, across every repo the viewer can see, in one
 * query.
 *
 * The shape this replaces was a loop: take the twenty most recent visible
 * repos, ask each of them for issues and again for pulls, forty queries for
 * one search box. It was also *wrong* in a way that only shows up with
 * scale — a hit in the twenty-first repo did not exist as far as the search
 * was concerned, and the twenty-first repo arrives on the day the forge gets
 * interesting.
 *
 * Ordered newest-first by id, which for a monotonic ULID is creation order
 * across every repo at once — the only ordering that means anything when the
 * rows come from everywhere.
 */
export function searchIssuesVisibleTo(
  db: Database,
  viewer: { id: string } | undefined,
  query: string,
  options: { limit?: number; kind?: IssueKind } = {},
): IssueHit[] {
  const text = query.trim();
  if (text === "") return [];
  const params: (string | number)[] = [
    viewer?.id ?? "",
    `%${likeEscape(text)}%`,
  ];
  let where = `${repoVisible(viewer !== undefined)}
    AND issue.title LIKE ?2 ESCAPE '\\' COLLATE NOCASE`;
  if (options.kind !== undefined) {
    params.push(options.kind);
    where += ` AND issue.kind = ?${params.length}`;
  }
  params.push(pageLimit(options.limit));
  return db
    .query<
      IssueRow & { owner_name: string; repo_name: string },
      (string | number)[]
    >(
      `SELECT issue.*, user.username AS author_name,
              owner.username AS owner_name, repo.name AS repo_name
       FROM issue
       JOIN user ON user.id = issue.author_id
       JOIN repo ON repo.id = issue.repo_id
       JOIN user AS owner ON owner.id = repo.owner_id
       WHERE ${where}
       ORDER BY issue.id DESC LIMIT ?${params.length}`,
    )
    .all(...params)
    .map((row) => ({
      ...toIssue(row),
      ownerName: row.owner_name,
      repoName: row.repo_name,
    }));
}
