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

/** A name a filer may claim without a token: an account name's shape. */
export const CLAIM_MAX = 64;
const CLAIM_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Who filed a report. `signed`: a token or session proved the account, and
 * `name` is its username now. `claimed`: a name given with no proof — a
 * claim, shown as one. `anonymous`: neither, and no name is made up.
 */
export interface FiledBy {
  readonly how: "signed" | "claimed" | "anonymous";
  readonly name: string | null;
}

export const ANONYMOUS: FiledBy = { how: "anonymous", name: null };

export interface Report {
  readonly id: string;
  readonly repoId: string;
  readonly title: string;
  readonly body: string;
  readonly page: string | null;
  readonly state: ReportState;
  readonly createdAt: string;
  readonly filedBy: FiledBy;
  /** The proven filer's account id, for the trust check; never shown. */
  readonly filerId: string | null;
}

export type ReportError =
  | "empty_title"
  | "title_too_long"
  | "body_too_long"
  | "invalid_agent";

interface ReportRow {
  id: string;
  repo_id: string;
  title: string;
  body: string;
  page: string | null;
  state: ReportState;
  created_at: string;
  filer_id: string | null;
  filer_name: string | null;
  claimed: string | null;
}

const filedByOf = (row: ReportRow): FiledBy =>
  row.filer_id !== null && row.filer_name !== null
    ? { how: "signed", name: row.filer_name }
    : row.claimed !== null
      ? { how: "claimed", name: row.claimed }
      : ANONYMOUS;

/** A report's row with its proven filer's name as it is now. */
const SELECT_REPORT = `SELECT report.*, user.username AS filer_name
    FROM report LEFT JOIN user ON user.id = report.filer_id`;

const fromRow = (row: ReportRow): Report => ({
  id: row.id,
  repoId: row.repo_id,
  title: row.title,
  body: row.body,
  page: row.page,
  state: row.state,
  createdAt: row.created_at,
  filedBy: filedByOf(row),
  filerId: row.filer_id,
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
  /** A name the filer gives for itself; empty for none. Kept only when no
   * account is proven, and then only as a claim. */
  readonly agent?: string;
}

export interface CleanReport {
  readonly title: string;
  readonly body: string;
  readonly page: string | null;
  readonly claimed: string | null;
}

/** A claimed name as stored: an account name's shape, or refused. */
export function claimOf(raw: string): Result<string | null, "invalid_agent"> {
  const name = raw.trim();
  if (name === "") return ok(null);
  if (name.length > CLAIM_MAX || !CLAIM_SHAPE.test(name))
    return err("invalid_agent");
  return ok(name);
}

/** The input as it will be stored, or why it will not be. */
export function cleanReport(
  input: ReportInput,
): Result<CleanReport, ReportError> {
  const title = plainText(input.title).replace(/\s+/g, " ").trim();
  if (title === "") return err("empty_title");
  if (title.length > TITLE_MAX) return err("title_too_long");
  const body = plainText(input.body).trim();
  if (body.length > BODY_MAX) return err("body_too_long");
  const claimed = claimOf(input.agent ?? "");
  if (!claimed.ok) return claimed;
  return ok({ title, body, page: pageOf(input.page.trim()), claimed: claimed.value });
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
  input: { title: string; body: string; page: string | null; claimed?: string | null },
  filerId: string | null = null,
): Report {
  const reportId = id();
  // A proven account is the identity; a claim beside it would only muddy it.
  db.query(
    `INSERT INTO report (id, repo_id, title, body, page, filer_id, claimed)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(
    reportId,
    repoId,
    input.title,
    input.body,
    input.page,
    filerId,
    filerId === null ? (input.claimed ?? null) : null,
  );
  return getReport(db, repoId, reportId)!;
}

export function getReport(
  db: Database,
  repoId: string,
  reportId: string,
): Report | undefined {
  const row = db
    .query(`${SELECT_REPORT} WHERE report.repo_id = ?1 AND report.id = ?2`)
    .get(repoId, reportId) as ReportRow | null;
  return row === null ? undefined : fromRow(row);
}

/** Waiting reports, oldest first: the order they should be read in. */
export function listWaiting(db: Database, repoId: string): Report[] {
  return (
    db
      .query(
        `${SELECT_REPORT} WHERE report.repo_id = ?1 AND report.state = 'pending'
          ORDER BY report.id LIMIT ?2`,
      )
      .all(repoId, WAITING_MAX) as ReportRow[]
  ).map(fromRow);
}

/** One filer's share of the waiting reports. */
export interface FilerCount extends FiledBy {
  readonly count: number;
}

/**
 * Waiting reports grouped by who filed them, most first, ties by name:
 * a signed `muse` and someone claiming to be `muse` are two groups, and
 * every anonymous report is one.
 */
export function byFiler(reports: readonly Report[]): FilerCount[] {
  const groups = new Map<string, FilerCount>();
  for (const r of reports) {
    const key = `${r.filedBy.how}:${r.filedBy.name ?? ""}`;
    const seen = groups.get(key);
    groups.set(key, { ...r.filedBy, count: (seen?.count ?? 0) + 1 });
  }
  const rank = { signed: 0, claimed: 1, anonymous: 2 } as const;
  return [...groups.values()].sort(
    (a, b) =>
      b.count - a.count ||
      rank[a.how] - rank[b.how] ||
      (a.name ?? "").localeCompare(b.name ?? ""),
  );
}

/** How a filer reads in a sentence: `@muse`, `claims to be muse`, `anonymous`. */
export function filerWords(by: FiledBy): string {
  if (by.how === "signed") return `@${by.name}`;
  if (by.how === "claimed") return `claims to be ${by.name}, unproven`;
  return "anonymous";
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
