/**
 * Reviews in flight, per reviewer, as /boards and the terminal's Flow dialog
 * say them. The count is `reviewLoad` from crew/review.ts, the one routing
 * reads; `publicOnly` cuts it to repositories the reader may see.
 */

import type { Database } from "bun:sqlite";
import { reviewLoad } from "../crew/review.ts";

export interface ReviewerLoad {
  readonly reviewer: string;
  readonly count: number;
}

/** Reviewers with a review in flight, busiest first. */
export function reviewersBusy(db: Database, publicOnly = false): ReviewerLoad[] {
  const load = reviewLoad(db, publicOnly);
  const out: ReviewerLoad[] = [];
  const name = db.query<{ username: string }, [string]>("SELECT username FROM user WHERE id = ?1");
  for (const [id, count] of load) {
    const row = name.get(id);
    if (row) out.push({ reviewer: row.username, count });
  }
  return out.sort((a, b) => b.count - a.count || a.reviewer.localeCompare(b.reviewer));
}

/** One sentence, or null when no review is out. */
export function reviewingSays(rows: readonly ReviewerLoad[]): string | null {
  if (rows.length === 0) return null;
  const total = rows.reduce((n, r) => n + r.count, 0);
  const list = rows.map((r) => `${r.reviewer} ${r.count}`).join(", ");
  return `${total} ${total === 1 ? "review" : "reviews"} in flight: ${list}.`;
}
