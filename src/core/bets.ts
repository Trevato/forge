/**
 * Bets (#8713): the thin record over a repository's issues. A bet names a
 * whole, says how much of the week it may take, what done looks like, and
 * which issues are its scopes. Plain rows in and out; the rules are in
 * `crew/bets.ts`, authorization and events in `actions/bets.ts`.
 */

import type { Database } from "bun:sqlite";
import { id as newId } from "../kernel/id.ts";
import type { Span } from "../crew/bets.ts";

export type BetState = "proposed" | "backed" | "stopped" | "done" | "cut";

export interface Bet {
  readonly id: string;
  readonly repoId: string;
  readonly name: string;
  readonly journeys: string;
  readonly appetite: number;
  readonly leadId: string | null;
  readonly state: BetState;
  readonly backedBy: "" | "owner" | "planner";
  readonly leftLine: string;
  readonly tryUrl: string;
  readonly verdict: "" | "done" | "not_yet";
  readonly verdictWhy: string;
  readonly proposedAt: string;
  readonly backedAt: string | null;
  readonly endedAt: string | null;
}

interface Row {
  id: string; repo_id: string; name: string; journeys: string; appetite: number; lead_id: string | null;
  state: BetState; backed_by: "" | "owner" | "planner"; left_line: string; try_url: string;
  verdict: "" | "done" | "not_yet"; verdict_why: string; proposed_at: string; backed_at: string | null; ended_at: string | null;
}

const toBet = (r: Row): Bet => ({
  id: r.id, repoId: r.repo_id, name: r.name, journeys: r.journeys, appetite: r.appetite, leadId: r.lead_id,
  state: r.state, backedBy: r.backed_by, leftLine: r.left_line, tryUrl: r.try_url, verdict: r.verdict,
  verdictWhy: r.verdict_why, proposedAt: r.proposed_at, backedAt: r.backed_at, endedAt: r.ended_at,
});

export function getBet(db: Database, id: string): Bet | undefined {
  const r = db.query<Row, [string]>("SELECT * FROM bet WHERE id = ?1").get(id);
  return r === null ? undefined : toBet(r);
}

/** A repository's bets, the running first, then by when they were proposed. */
export function listBets(db: Database, repoId: string): Bet[] {
  return db
    .query<Row, [string]>(
      `SELECT * FROM bet WHERE repo_id = ?1
        ORDER BY CASE state WHEN 'backed' THEN 0 WHEN 'stopped' THEN 1 WHEN 'proposed' THEN 2 ELSE 3 END, proposed_at, id`,
    )
    .all(repoId)
    .map(toBet);
}

export function insertBet(
  db: Database,
  b: { repoId: string; name: string; journeys: string; appetite: number; leadId: string | null; issueIds: readonly string[] },
  at: Date,
): Bet {
  const id = newId();
  db.transaction(() => {
    db.query(
      "INSERT INTO bet (id, repo_id, name, journeys, appetite, lead_id, proposed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).run(id, b.repoId, b.name, b.journeys, b.appetite, b.leadId, at.toISOString());
    for (const issue of b.issueIds) db.query("INSERT OR IGNORE INTO bet_issue (bet_id, issue_id) VALUES (?1, ?2)").run(id, issue);
  })();
  return getBet(db, id)!;
}

/** Back a bet: running, with this share, by the owner or the planner. */
export function markBacked(db: Database, id: string, share: number, by: "owner" | "planner", at: Date): void {
  db.query("UPDATE bet SET state = 'backed', appetite = ?2, backed_by = ?3, backed_at = CASE WHEN state = 'backed' THEN backed_at ELSE ?4 END, left_line = '', ended_at = NULL WHERE id = ?1")
    .run(id, share, by, at.toISOString());
}

export function markEnded(db: Database, id: string, state: "stopped" | "done" | "cut", at: Date, leftLine?: string): void {
  db.query("UPDATE bet SET state = ?2, ended_at = ?3, left_line = COALESCE(?4, left_line) WHERE id = ?1")
    .run(id, state, at.toISOString(), leftLine ?? null);
}

export function setLeftLine(db: Database, id: string, line: string): void {
  db.query("UPDATE bet SET left_line = ?2 WHERE id = ?1").run(id, line);
}

export function setVerdict(db: Database, id: string, verdict: "done" | "not_yet", why: string): void {
  db.query("UPDATE bet SET verdict = ?2, verdict_why = ?3 WHERE id = ?1").run(id, verdict, why);
}

export function setTryUrl(db: Database, id: string, url: string): void {
  db.query("UPDATE bet SET try_url = ?2 WHERE id = ?1").run(id, url);
}

/** Whether the owner has ever backed a bet here: from then on, the picks come from bets. */
export function betsInUse(db: Database, repoId: string): boolean {
  return db.query("SELECT 1 FROM bet WHERE repo_id = ?1 AND backed_by <> '' LIMIT 1").get(repoId) !== null;
}

/** For these issues, the backed bet each is a scope of (one read). */
export function backedBetOf(db: Database, repoId: string, issueIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (issueIds.length === 0) return out;
  const rows = db
    .query<{ issue_id: string; bet_id: string }, string[]>(
      `SELECT bi.issue_id, bi.bet_id FROM bet_issue bi JOIN bet b ON b.id = bi.bet_id
        WHERE b.repo_id = ?1 AND b.state = 'backed' AND bi.issue_id IN (${issueIds.map((_, n) => `?${n + 2}`).join(",")})
        ORDER BY b.backed_at, b.id`,
    )
    .all(repoId, ...issueIds);
  for (const r of rows) if (!out.has(r.issue_id)) out.set(r.issue_id, r.bet_id);
  return out;
}

export interface Scope {
  readonly issueId: string;
  readonly number: number;
  readonly title: string;
  readonly closed: boolean;
  readonly ran: boolean;
  readonly movedAt: string;
}

/** A bet's scopes: each issue with whether it closed, whether a run ever worked it, and when it last moved. */
export function betScopes(db: Database, betId: string): Scope[] {
  return db
    .query<{ id: string; number: number; title: string; state: string; updated_at: string; last_run: string | null }, [string]>(
      `SELECT i.id, i.number, i.title, i.state, i.updated_at,
              (SELECT MAX(created_at) FROM run r WHERE r.issue_id = i.id AND r.kind = 'agent') AS last_run
         FROM bet_issue bi JOIN issue i ON i.id = bi.issue_id
        WHERE bi.bet_id = ?1 ORDER BY i.number`,
    )
    .all(betId)
    .map((r) => ({
      issueId: r.id, number: r.number, title: r.title, closed: r.state !== "open", ran: r.last_run !== null,
      movedAt: r.last_run !== null && r.last_run > r.updated_at ? r.last_run : r.updated_at,
    }));
}

/** The builder runs on a bet's scopes since it was backed. */
export function betRuns(db: Database, betId: string, since: string): Span[] {
  return db
    .query<{ started_at: string | null; finished_at: string | null }, [string, string]>(
      `SELECT r.started_at, r.finished_at FROM run r
        WHERE r.kind = 'agent' AND r.started_at IS NOT NULL AND r.started_at >= ?2
          AND r.issue_id IN (SELECT issue_id FROM bet_issue WHERE bet_id = ?1)`,
    )
    .all(betId, since)
    .map((r) => ({ startedAt: r.started_at, finishedAt: r.finished_at }));
}

/** The bet name for pulls (by number) in `repoId`: through the run that built each from a scope, or the pull as a scope itself. */
export function betNamesOfPulls(db: Database, repoId: string, numbers: readonly number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (numbers.length === 0) return out;
  const rows = db
    .query<{ number: number; name: string }, (string | number)[]>(
      `SELECT p.number, b.name FROM issue p
         JOIN pull pl ON pl.issue_id = p.id
         JOIN bet b ON b.repo_id = p.repo_id
        WHERE p.repo_id = ?1 AND p.number IN (${numbers.map((_, n) => `?${n + 2}`).join(",")})
          AND (EXISTS (SELECT 1 FROM bet_issue bi WHERE bi.bet_id = b.id AND bi.issue_id = p.id)
            OR EXISTS (SELECT 1 FROM run r JOIN bet_issue bi ON bi.issue_id = r.issue_id
                        WHERE bi.bet_id = b.id AND r.repo_id = p.repo_id AND r.branch = pl.head_branch))
        ORDER BY b.proposed_at, b.id`,
    )
    .all(repoId, ...numbers);
  for (const r of rows) if (!out.has(r.number)) out.set(r.number, r.name);
  return out;
}
