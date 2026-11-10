/**
 * The week's scorecard line per crew member (#10722): pulls merged, pulls
 * returned by review, and spend over the last 7 days, so an owner sees who
 * earns its keep without opening runs. Three grouped reads, no per-agent
 * query; spend comes from the usage ledger, not the run rows.
 *
 * - merged   = pulls the agent authored that merged in the window
 * - returned = changes-requested reviews by someone else in the window on pulls it authored
 * - spentUsd = ledger cost attributed to the agent in the window
 * A member with all three at nothing is `idle`, said as a word, not as zeros.
 */

import type { Database } from "bun:sqlite";

export const WEEK_DAYS = 7;

export interface WeekLine {
  readonly username: string;
  readonly merged: number;
  readonly returned: number;
  readonly spentUsd: number;
  readonly idle: boolean;
}

const money = (n: number) => Math.round(n * 10_000) / 10_000;

/** Every agent's line for the 7 days before `now`, by username. */
export function weekCard(db: Database, now: Date = new Date()): WeekLine[] {
  const since = new Date(now.getTime() - WEEK_DAYS * 86_400_000).toISOString();
  const count = (sql: string) =>
    new Map(db.query<{ id: string; n: number }, [string]>(sql).all(since).map((r) => [r.id, r.n]));
  const merged = count(
    `SELECT issue.author_id AS id, COUNT(*) AS n FROM pull
       JOIN issue ON issue.id = pull.issue_id
      WHERE pull.merged_at >= ?1 GROUP BY issue.author_id`,
  );
  const returned = count(
    `SELECT issue.author_id AS id, COUNT(*) AS n FROM review
       JOIN issue ON issue.id = review.issue_id
       JOIN pull ON pull.issue_id = issue.id
      WHERE review.state = 'changes_requested' AND review.author_id <> issue.author_id
        AND review.created_at >= ?1
      GROUP BY issue.author_id`,
  );
  const spent = count(
    `SELECT agent_id AS id, SUM(cost_usd) AS n FROM usage
      WHERE agent_id IS NOT NULL AND at >= ?1 GROUP BY agent_id`,
  );
  return db
    .query<{ id: string; username: string }, []>(
      `SELECT user.id AS id, user.username AS username FROM user
        WHERE user.is_agent = 1 ORDER BY user.username COLLATE NOCASE`,
    )
    .all()
    .map((u) => {
      const m = merged.get(u.id) ?? 0;
      const r = returned.get(u.id) ?? 0;
      const s = money(spent.get(u.id) ?? 0);
      return { username: u.username, merged: m, returned: r, spentUsd: s, idle: m === 0 && r === 0 && s === 0 };
    });
}

export interface ReturnedPull {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  /** The first line of the change request, clipped; empty when the review had no words. */
  readonly why: string;
}

/** Most pulls listed per member; the rest are counted, not listed. */
export const RETURNED_CAP = 10;

/**
 * The pulls behind each member's Returned count, newest first, at most
 * RETURNED_CAP per member (by username). One read for the whole page; it
 * counts the same reviews as `weekCard`, one entry per change request.
 */
export function weekReturns(db: Database, now: Date = new Date()): Map<string, ReturnedPull[]> {
  const since = new Date(now.getTime() - WEEK_DAYS * 86_400_000).toISOString();
  const rows = db
    .query<{ username: string; repo: string; number: number; title: string; body: string }, [string, number]>(
      `SELECT username, repo, number, title, body FROM (
         SELECT author.username AS username, owner.username || '/' || repo.name AS repo,
                issue.number AS number, issue.title AS title, review.body AS body,
                ROW_NUMBER() OVER (PARTITION BY issue.author_id ORDER BY review.created_at DESC, review.id) AS rn
           FROM review
           JOIN issue ON issue.id = review.issue_id
           JOIN pull ON pull.issue_id = issue.id
           JOIN repo ON repo.id = issue.repo_id
           JOIN user AS owner ON owner.id = repo.owner_id
           JOIN user AS author ON author.id = issue.author_id
          WHERE review.state = 'changes_requested' AND review.author_id <> issue.author_id
            AND review.created_at >= ?1 AND author.is_agent = 1
       ) WHERE rn <= ?2 ORDER BY username, rn`,
    )
    .all(since, RETURNED_CAP);
  const out = new Map<string, ReturnedPull[]>();
  for (const r of rows) {
    const first = (r.body.split("\n").find((l) => l.trim() !== "") ?? "").trim();
    const why = first.length > 140 ? `${first.slice(0, 139)}…` : first;
    const list = out.get(r.username) ?? [];
    list.push({ repo: r.repo, number: r.number, title: r.title, why });
    out.set(r.username, list);
  }
  return out;
}
