/**
 * Bugs on a clock (#8709): an open issue labelled `bug` is answered, fixed or
 * closed as won't fix, within 4 hours when it is also labelled `high` and 48
 * hours otherwise. Pure over the db and `now`. Dispatch starts bugs ahead of
 * other work (`bugsFirst`), home counts them (`countBugs`), and one flow
 * alarm names the oldest one past its clock (`bugClockAlarm`).
 */

import type { Database } from "bun:sqlite";
import type { Run } from "../core/runs.ts";

const HOUR_MS = 3_600_000;
export const HIGH_BUG_MS = 4 * HOUR_MS;
export const LOW_BUG_MS = 48 * HOUR_MS;

const HIGH_NAMES = "('high', 'priority: high', 'priority:high')";

export interface OpenBug {
  readonly repo: string;
  readonly number: number;
  readonly createdAt: string;
  readonly high: boolean;
  /** When its clock runs out (ISO). */
  readonly dueAt: string;
}

export interface BugCount {
  readonly open: number;
  readonly overdue: number;
}

interface BugRow {
  readonly owner: string | null;
  readonly name: string | null;
  readonly number: number;
  readonly created_at: string;
  readonly high: number;
}

/**
 * The one open-bug query. `named` joins the repository and its owner (for the
 * alarm); the count needs neither, and without them it reads only issue and labels.
 */
function readBugRows(db: Database, named: boolean, publicOnly: boolean): BugRow[] {
  const repo = named ? "JOIN repo r ON r.id = i.repo_id JOIN user u ON u.id = r.owner_id" : "";
  const who = named ? "u.username AS owner, r.name AS name" : "NULL AS owner, NULL AS name";
  return db
    .query<BugRow, []>(
      `SELECT ${who}, ${named ? "i.number" : "0 AS number"}, i.created_at,
              EXISTS (SELECT 1 FROM issue_label h JOIN label hl ON hl.id = h.label_id
                       WHERE h.issue_id = i.id AND hl.name COLLATE NOCASE IN ${HIGH_NAMES}) AS high
         FROM issue i ${repo}
         JOIN issue_label il ON il.issue_id = i.id
         JOIN label l ON l.id = il.label_id AND l.name = 'bug' COLLATE NOCASE
        WHERE i.kind = 'issue' AND i.state = 'open' ${named && publicOnly ? "AND r.visibility = 'public'" : ""}
        ORDER BY i.created_at`,
    )
    .all();
}

const dueMs = (r: BugRow): number => Date.parse(r.created_at) + (r.high === 1 ? HIGH_BUG_MS : LOW_BUG_MS);

/** Every open bug in a public or private repository alike; `publicOnly` leaves private ones out. */
export function openBugs(db: Database, opts: { readonly publicOnly?: boolean } = {}): OpenBug[] {
  return readBugRows(db, true, opts.publicOnly === true).map((r) => ({
    repo: `${r.owner}/${r.name}`,
    number: r.number,
    createdAt: r.created_at,
    high: r.high === 1,
    dueAt: new Date(dueMs(r)).toISOString(),
  }));
}

export function countBugs(db: Database, now: Date): BugCount {
  const rows = readBugRows(db, false, false);
  return { open: rows.length, overdue: rows.filter((r) => dueMs(r) <= now.getTime()).length };
}

export interface BugClockAlarm {
  readonly fired: boolean;
  /** When the oldest overdue bug's clock ran out; only when fired. */
  readonly since?: string;
  readonly says: string;
  readonly href: string;
}

/** One alarm for all the bugs past their clock, naming the one that has waited longest. */
export function bugClockAlarm(db: Database, now: Date, opts: { readonly publicOnly?: boolean } = {}): BugClockAlarm {
  const late = openBugs(db, opts)
    .filter((b) => Date.parse(b.dueAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const first = late[0];
  if (!first) return { fired: false, says: "No bug is past its clock.", href: "/boards" };
  const hours = Math.floor((now.getTime() - Date.parse(first.dueAt)) / HOUR_MS);
  const more = late.length > 1 ? ` and ${late.length - 1} more` : "";
  return {
    fired: true,
    since: first.dueAt,
    says: `Bug past its clock: ${first.repo}#${first.number}${more} still open, ${hours} h over its ${first.high ? "4 h" : "48 h"} limit. Fix it or close it as won't fix, with a reason.`,
    href: `/${first.repo}/issues/${first.number}`,
  };
}

/** Queued runs with those about an open bug first; each side keeps its order. */
export function bugsFirst(db: Database, queued: Run[]): Run[] {
  const ids = queued.flatMap((r) => (r.issueId ? [r.issueId] : []));
  if (ids.length === 0 || queued.length < 2) return queued;
  const marks = ids.map(() => "?").join(",");
  const bugs = new Set(
    db
      .query<{ id: string }, string[]>(
        `SELECT i.id FROM issue i JOIN issue_label il ON il.issue_id = i.id
           JOIN label l ON l.id = il.label_id AND l.name = 'bug' COLLATE NOCASE
          WHERE i.id IN (${marks}) AND i.state = 'open'`,
      )
      .all(...ids)
      .map((r) => r.id),
  );
  if (bugs.size === 0) return queued;
  const isBug = (r: Run) => r.issueId !== null && bugs.has(r.issueId);
  return [...queued.filter(isBug), ...queued.filter((r) => !isBug(r))];
}
