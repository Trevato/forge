/**
 * Spend reported from outside: what a session the forge did not run says a
 * change cost it. A claim, kept as said, shown apart from the crew's own
 * runs (`core/returns.ts` never adds it in) and read by no limit. Pure data;
 * who may report is `actions/returns.ts`'s to decide.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";

export interface OutsideSpend {
  readonly id: string;
  readonly repoId: string;
  readonly issueId: string | null;
  readonly reporterId: string;
  /** The session as it names itself: "steward build team", "my assistant". */
  readonly who: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly usd: number;
  readonly note: string;
  readonly createdAt: string;
}

export type NewOutsideSpend = Omit<OutsideSpend, "id" | "createdAt">;

export function recordOutsideSpend(db: Database, input: NewOutsideSpend): OutsideSpend {
  const row = db
    .query<{ id: string; created_at: string }, (string | number | null)[]>(
      `INSERT INTO outside_spend (id, repo_id, issue_id, reporter_id, who, model, tokens_in, tokens_out, usd, note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id, created_at`,
    )
    .get(
      id(),
      input.repoId,
      input.issueId,
      input.reporterId,
      input.who,
      input.model,
      input.tokensIn,
      input.tokensOut,
      input.usd,
      input.note,
    )!;
  return { ...input, id: row.id, createdAt: row.created_at };
}

export interface OutsideTotal {
  readonly who: string;
  readonly reports: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly usd: number;
}

/** What outside sessions reported for these repositories in the window, by who, most dollars first. */
export function outsideSpendIn(
  db: Database,
  repoIds: readonly string[],
  since: string,
  until: string,
): OutsideTotal[] {
  if (repoIds.length === 0) return [];
  const n = repoIds.length;
  return db
    .query<OutsideTotal, string[]>(
      `SELECT who, COUNT(*) AS reports, SUM(tokens_in) AS tokensIn, SUM(tokens_out) AS tokensOut,
              ROUND(SUM(usd), 2) AS usd
       FROM outside_spend
       WHERE repo_id IN (${repoIds.map((_, i) => `?${i + 1}`).join(",")})
         AND created_at >= ?${n + 1} AND created_at < ?${n + 2}
       GROUP BY who ORDER BY SUM(usd) DESC`,
    )
    .all(...repoIds, since, until);
}
