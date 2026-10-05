/**
 * Reports from outside: words a stranger left on a public repository, with
 * no account. A report is not an issue, on purpose — every reader of issues
 * (the crew's briefs, autonomy, the feed, search, the MCP) would otherwise
 * have to remember to skip it, and one that forgot would hand a stranger's
 * text to an agent. Here nothing reads a report but a person who writes the
 * repository; accepting one opens an ordinary issue in that person's name
 * (`actions/reports.ts`). Pure data, no authz, no events.
 */
import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const TITLE_MAX = 200;
export const BODY_MAX = 8_000;
export const PAGE_MAX = 500;
/** A whole report request, in bytes: the text caps at four bytes a character, and room. */
export const REQUEST_MAX = 64 * 1024;
/** Waiting reports one repository holds; past this a stranger is told so. */
export const WAITING_MAX = 100;

export type ReportState = "pending" | "accepted" | "dismissed";

export interface Report {
  readonly id: string;
  readonly repoId: string;
  readonly title: string;
  readonly body: string;
  readonly page: string | null;
  readonly state: ReportState;
  readonly createdAt: string;
}

export type ReportError = "empty_title" | "title_too_long" | "body_too_long";

interface ReportRow {
  id: string;
  repo_id: string;
  title: string;
  body: string;
  page: string | null;
  state: ReportState;
  created_at: string;
}

const fromRow = (row: ReportRow): Report => ({
  id: row.id,
  repoId: row.repo_id,
  title: row.title,
  body: row.body,
  page: row.page,
  state: row.state,
  createdAt: row.created_at,
});

/**
 * Text only. Control characters (but newline and tab) and the bidirectional
 * overrides that make text read differently from what it is are dropped,
 * so what a person reads is what was sent.
 */
export function plainText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g, "");
}

/** Only an http(s) address is kept as the page a report came from. */
function pageOf(raw: string): string | null {
  if (raw === "" || raw.length > PAGE_MAX) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export interface ReportInput {
  readonly title: string;
  readonly body: string;
  readonly page: string;
}

/** The input as it will be stored, or why it will not be. */
export function cleanReport(
  input: ReportInput,
): Result<{ title: string; body: string; page: string | null }, ReportError> {
  const title = plainText(input.title).replace(/\s+/g, " ").trim();
  if (title === "") return err("empty_title");
  if (title.length > TITLE_MAX) return err("title_too_long");
  const body = plainText(input.body).trim();
  if (body.length > BODY_MAX) return err("body_too_long");
  return ok({ title, body, page: pageOf(input.page.trim()) });
}

/**
 * How an issue made from a report says where it came from: its title opens
 * with `OUTSIDE_TITLE` and it carries the label `OUTSIDE_LABEL`, so neither
 * a person nor an agent reads a stranger's words as the accepting person's.
 */
export const OUTSIDE_TITLE = "From outside: ";
export const OUTSIDE_LABEL = "outside";
export const OUTSIDE_COLOR = "b45309";

/** Whether a title already says it came from outside. */
export const saysOutside = (title: string): boolean =>
  title.toLowerCase().startsWith(OUTSIDE_TITLE.trim().toLowerCase());

/**
 * A title's own words: one line of plain text, with any marker in front —
 * the reporter's own, or one typed back in — taken off.
 */
export function outsideWords(title: string): string {
  let words = plainText(title).replace(/\s+/g, " ").trim();
  while (saysOutside(words))
    words = words.slice(OUTSIDE_TITLE.trim().length).trim();
  return words;
}

/**
 * The title of the issue an accepted report becomes: the words as the
 * accepting person left them, behind the marker. There is exactly one
 * marker and no edit removes it.
 */
export function outsideTitle(
  title: string,
): Result<string, "empty_title" | "title_too_long"> {
  const words = outsideWords(title);
  if (words === "") return err("empty_title");
  if (words.length > TITLE_MAX) return err("title_too_long");
  return ok(`${OUTSIDE_TITLE}${words}`);
}

export function countWaiting(db: Database, repoId: string): number {
  return (
    db
      .query(
        "SELECT count(*) AS n FROM report WHERE repo_id = ?1 AND state = 'pending'",
      )
      .get(repoId) as { n: number }
  ).n;
}

export function insertReport(
  db: Database,
  repoId: string,
  input: { title: string; body: string; page: string | null },
): Report {
  const reportId = id();
  db.query(
    "INSERT INTO report (id, repo_id, title, body, page) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(reportId, repoId, input.title, input.body, input.page);
  return getReport(db, repoId, reportId)!;
}

export function getReport(
  db: Database,
  repoId: string,
  reportId: string,
): Report | undefined {
  const row = db
    .query("SELECT * FROM report WHERE repo_id = ?1 AND id = ?2")
    .get(repoId, reportId) as ReportRow | null;
  return row === null ? undefined : fromRow(row);
}

/** Waiting reports, oldest first: the order they should be read in. */
export function listWaiting(db: Database, repoId: string): Report[] {
  return (
    db
      .query(
        "SELECT * FROM report WHERE repo_id = ?1 AND state = 'pending' ORDER BY id LIMIT ?2",
      )
      .all(repoId, WAITING_MAX) as ReportRow[]
  ).map(fromRow);
}

/**
 * Decide a waiting report, once. `false` when it was already decided — two
 * people pressing accept at once open one issue, not two.
 */
export function decideReport(
  db: Database,
  reportId: string,
  decision: { state: "accepted" | "dismissed"; by: string },
): boolean {
  return (
    db
      .query(
        `UPDATE report SET state = ?2, decided_by = ?3,
                decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?1 AND state = 'pending'`,
      )
      .run(reportId, decision.state, decision.by).changes === 1
  );
}

/** The issue an accepted report became. */
export function noteIssue(db: Database, reportId: string, issueNumber: number): void {
  db.query("UPDATE report SET issue_number = ?2 WHERE id = ?1").run(
    reportId,
    issueNumber,
  );
}

/** An acceptance whose issue could not be opened waits again. */
export function undecideReport(db: Database, reportId: string): void {
  db.query(
    `UPDATE report SET state = 'pending', decided_by = NULL, decided_at = NULL
      WHERE id = ?1 AND issue_number IS NULL`,
  ).run(reportId);
}
