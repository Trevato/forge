/**
 * Estimates against an issue (#11955): rows kept, never edited. The forge sets
 * the actual instant when the event happens (`settleEvent`, `settleLive`) and
 * voids what an abandoned issue leaves open (`voidOpen`); nobody does it by hand.
 * This module reads no pulls and no releases: `actions/estimates_settle.ts` is the one place
 * that hears of the events and calls these.
 * Plain data in and out; the base rate and the scores are `flow/`.
 */
import type { Database } from "bun:sqlite";
import type { User } from "./users.ts";
import { repoVisible } from "./visibility.ts";

export const EVENTS = ["pull_opened", "merged", "live", "done"] as const;
export type EstimateEvent = (typeof EVENTS)[number];
export const isEvent = (v: unknown): v is EstimateEvent => typeof v === "string" && (EVENTS as readonly string[]).includes(v);

export type EstimateState = "open" | "resolved" | "void";

export interface EstimateRow {
  readonly id: number;
  readonly repoId: string;
  readonly issueId: string;
  readonly issueNumber: number;
  readonly event: EstimateEvent;
  readonly p50At: string;
  readonly p90At: string;
  readonly madeAt: string;
  readonly byId: string;
  readonly byName: string;
  readonly byKind: "person" | "agent";
  readonly basis: string;
  /** The base rate shown when it was made: the raw JSON; `flow/estimate_base.ts` reads it. */
  readonly baseJson: string;
  readonly size: string;
  readonly kind: string;
  readonly actualAt: string | null;
  readonly voidedAt: string | null;
  readonly state: EstimateState;
}

interface Raw {
  id: number;
  repo_id: string;
  issue_id: string;
  number: number;
  event: EstimateEvent;
  p50_at: string;
  p90_at: string;
  made_at: string;
  by_id: string;
  username: string;
  by_kind: "person" | "agent";
  basis: string;
  base_json: string;
  size: string;
  kind: string;
  actual_at: string | null;
  voided_at: string | null;
}

const SELECT = `SELECT e.id, e.repo_id, e.issue_id, i.number, e.event, e.p50_at, e.p90_at, e.made_at, e.by_id,
       u.username, e.by_kind, e.basis, e.base_json, e.size, e.kind, e.actual_at, e.voided_at
  FROM issue_estimate e JOIN issue i ON i.id = e.issue_id JOIN user u ON u.id = e.by_id`;

const toRow = (r: Raw): EstimateRow => ({
  id: r.id,
  repoId: r.repo_id,
  issueId: r.issue_id,
  issueNumber: r.number,
  event: r.event,
  p50At: r.p50_at,
  p90At: r.p90_at,
  madeAt: r.made_at,
  byId: r.by_id,
  byName: r.username,
  byKind: r.by_kind,
  basis: r.basis,
  baseJson: r.base_json,
  size: r.size,
  kind: r.kind,
  actualAt: r.actual_at,
  voidedAt: r.voided_at,
  state: r.voided_at !== null ? "void" : r.actual_at !== null ? "resolved" : "open",
});

export interface NewEstimate {
  readonly repoId: string;
  readonly issueId: string;
  readonly event: EstimateEvent;
  readonly p50At: string;
  readonly p90At: string;
  readonly madeAt: string;
  readonly byId: string;
  readonly byKind: "person" | "agent";
  readonly basis: string;
  readonly baseJson: string;
  readonly size: string;
  readonly kind: string;
}

/**
 * Keep one estimate. Rows are only added: the older one for the same event is superseded by being
 * older.
 */
export function addEstimate(db: Database, e: NewEstimate): number {
  return Number(
    db
      .query(
        `INSERT INTO issue_estimate (repo_id, issue_id, event, p50_at, p90_at, made_at, by_id, by_kind, basis, base_json, size, kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .run(e.repoId, e.issueId, e.event, e.p50At, e.p90At, e.madeAt, e.byId, e.byKind, e.basis, e.baseJson, e.size, e.kind)
      .lastInsertRowid,
  );
}

/** Every estimate on an issue, oldest first: the revisions are data. */
export function estimatesOf(db: Database, issueId: string): EstimateRow[] {
  return db.query<Raw, [string]>(`${SELECT} WHERE e.issue_id = ?1 ORDER BY e.id`).all(issueId).map(toRow);
}

/** What each event stands at now: the newest estimate per event (events in their order). */
export function currentOf(rows: readonly EstimateRow[]): EstimateRow[] {
  const latest = new Map<EstimateEvent, EstimateRow>();
  for (const r of rows) latest.set(r.event, r);
  return EVENTS.flatMap((ev) => latest.get(ev) ?? []);
}

/** The most issue numbers one list read names. */
export const NUMBERS_MAX = 500;
/** The most rows a scorecard reads: the newest. */
export const SCORE_ROWS = 5000;

/**
 * The newest estimate per event for each issue number of a repository, for a list's rows (one
 * read of those issues' rows only).
 */
export function currentByNumber(db: Database, repoId: string, numbers: readonly number[]): Map<number, EstimateRow[]> {
  const out = new Map<number, EstimateRow[]>();
  if (numbers.length === 0) return out;
  const byIssue = new Map<number, EstimateRow[]>();
  for (const r of db
    .query<Raw, [string, string]>(
      `${SELECT} WHERE e.repo_id = ?1 AND i.number IN (SELECT value FROM json_each(?2)) ORDER BY e.id`,
    )
    .all(repoId, JSON.stringify(numbers.slice(0, NUMBERS_MAX)))
    .map(toRow))
    byIssue.set(r.issueNumber, [...(byIssue.get(r.issueNumber) ?? []), r]);
  for (const [n, rows] of byIssue) out.set(n, currentOf(rows));
  return out;
}

/**
 * The newest {@link SCORE_ROWS} estimates in repositories `viewer` may read (a signed-out viewer:
 * the public ones), oldest first, for the scorecards; `byId` keeps one estimator's.
 */
export function estimatesVisibleTo(db: Database, viewer: User | undefined, byId?: string): EstimateRow[] {
  const rows = db
    .query<Raw, [string, string, number]>(
      `${SELECT} JOIN repo ON repo.id = e.repo_id
        WHERE ${repoVisible(viewer !== undefined)} AND (?2 = '' OR e.by_id = ?2)
        ORDER BY e.id DESC LIMIT ?3`,
    )
    .all(viewer?.id ?? "", byId ?? "", SCORE_ROWS);
  return rows.reverse().map(toRow);
}

/**
 * The event happened for these issue numbers: their open estimates for it get the actual instant.
 * Returns how many.
 */
export function settleEvent(db: Database, repoId: string, numbers: readonly number[], event: EstimateEvent, at: string): number {
  let n = 0;
  for (const number of numbers)
    n += db
      .query(
        `UPDATE issue_estimate SET actual_at = ?4
          WHERE event = ?3 AND actual_at IS NULL AND voided_at IS NULL
            AND issue_id = (SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2)`,
      )
      .run(repoId, number, event, at).changes;
  return n;
}

/** A release that served: when it was cut and when it went live. */
export interface ServedRelease {
  readonly cutAt: string;
  readonly liveAt: string;
}

/**
 * Releases went live: every open `live` estimate whose issue merged at or before a release was cut
 * resolves at the first such release's `liveAt`. `mergedAt` says when the pull that closed an issue
 * merged (the caller reads pulls; this module reads none). `releases` are oldest first.
 */
export function settleLive(
  db: Database,
  releases: readonly ServedRelease[],
  mergedAt: (repoId: string, number: number) => string | undefined,
): number {
  if (releases.length === 0) return 0;
  const open = db
    .query<{ id: number; repo_id: string; number: number }, []>(
      `SELECT e.id, e.repo_id, i.number FROM issue_estimate e JOIN issue i ON i.id = e.issue_id
        WHERE e.event = 'live' AND e.actual_at IS NULL AND e.voided_at IS NULL`,
    )
    .all();
  let n = 0;
  for (const r of open) {
    const merged = mergedAt(r.repo_id, r.number);
    const release = merged === undefined ? undefined : releases.find((x) => x.cutAt >= merged);
    if (release === undefined) continue;
    n += db.query(`UPDATE issue_estimate SET actual_at = ?2 WHERE id = ?1 AND actual_at IS NULL AND voided_at IS NULL`).run(r.id, release.liveAt).changes;
  }
  return n;
}

/**
 * An issue closed as dropped or split, or moved to Not now: what it left open is kept, marked
 * void, never scored.
 */
export function voidOpen(db: Database, issueId: string, at: string = new Date().toISOString()): number {
  return db
    .query(`UPDATE issue_estimate SET voided_at = ?2 WHERE issue_id = ?1 AND actual_at IS NULL AND voided_at IS NULL`)
    .run(issueId, at).changes;
}

/** How long a closed issue stays closed before it counts as finished. */
export const DONE_AFTER_MS = 24 * 3_600_000;

/**
 * Open `done` estimates on issues that closed as done (#11955): the issue stayed closed 24 h, or a
 * release went live after the last pull that closed it merged, whichever the issue reached first.
 * `liveAfter` says when the first release cut after an instant went live; this module reads no
 * releases. Returns how many it settled.
 */
export function settleDone(
  db: Database,
  now: string,
  liveAfter: (mergedAt: string) => string | undefined,
  lastMerged: (repoId: string, number: number) => string | undefined,
): number {
  const open = db
    .query<{ id: number; repo_id: string; number: number; closed_at: string }, []>(
      `SELECT e.id, e.repo_id, i.number, i.closed_at FROM issue_estimate e JOIN issue i ON i.id = e.issue_id
        WHERE e.event = 'done' AND e.actual_at IS NULL AND e.voided_at IS NULL
          AND i.state = 'closed' AND i.close_reason = 'done' AND i.closed_at IS NOT NULL`,
    )
    .all();
  let n = 0;
  for (const r of open) {
    const stayed = new Date(Date.parse(r.closed_at) + DONE_AFTER_MS).toISOString();
    const merged = lastMerged(r.repo_id, r.number);
    const live = merged === undefined ? undefined : liveAfter(merged);
    const at = live !== undefined && live < stayed ? (live < r.closed_at ? r.closed_at : live) : stayed;
    if (at > now) continue;
    n += db.query(`UPDATE issue_estimate SET actual_at = ?2 WHERE id = ?1 AND actual_at IS NULL AND voided_at IS NULL`).run(r.id, at).changes;
  }
  return n;
}
