/**
 * The open crew pulls sorted into piles (#6472): 85 open pulls is one number,
 * and the owner needs to know which pile is the clog. Open, unmerged pulls
 * opened by a crew agent of the repository (an imported pull is no agent's),
 * each counted once, in the first pile it fits: red check, conflicted,
 * changes asked, approved and waiting, awaiting review.
 *
 * Red is `checks_pile.ts`'s: the latest check on the current head failed.
 * Conflicted is `conflicted.ts`'s `conflictedPulls`, both the runs and the
 * approved pulls waiting for room. A verdict is the latest approval or
 * request for changes; a bare comment is no verdict. `publicOnly` is
 * `readVitals`'s: public repositories alone.
 */

import type { Database } from "bun:sqlite";
import { conflictedPulls } from "./conflicted.ts";

export interface Pile {
  readonly red: number;
  readonly conflicted: number;
  readonly changesAsked: number;
  readonly approved: number;
  readonly awaitingReview: number;
  readonly total: number;
}

interface Row {
  readonly repo: string;
  readonly number: number;
  readonly red: number;
  readonly verdict: string | null;
}

export function readPile(db: Database, publicOnly = false): Pile {
  const rows = db
    .query<Row, [number]>(
      `SELECT o.username || '/' || r.name AS repo, i.number AS number,
              COALESCE((SELECT c.state FROM run c WHERE c.kind = 'check' AND c.issue_id = i.id
                          AND c.commit_oid = p.head_oid ORDER BY c.id DESC LIMIT 1) = 'failed', 0) AS red,
              (SELECT v.state FROM review v WHERE v.issue_id = i.id AND v.state IN ('approved','changes_requested')
                  ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS verdict
         FROM issue i JOIN pull p ON p.issue_id = i.id JOIN repo r ON r.id = i.repo_id
         JOIN user o ON o.id = r.owner_id JOIN user a ON a.id = i.author_id
        WHERE i.state = 'open' AND p.merged_at IS NULL AND (?1 = 0 OR r.visibility = 'public')
          AND a.is_agent = 1 AND COALESCE(i.origin_author, '') = ''
          AND EXISTS (SELECT 1 FROM repo_crew c WHERE c.repo_id = r.id AND c.user_id = a.id)`,
    )
    .all(publicOnly ? 1 : 0);
  const conflicted = new Set(conflictedPulls(db, publicOnly).map((p) => `${p.repo}#${p.number}`));
  const pile = { red: 0, conflicted: 0, changesAsked: 0, approved: 0, awaitingReview: 0 };
  for (const row of rows) {
    if (row.red) pile.red++;
    else if (conflicted.has(`${row.repo}#${row.number}`)) pile.conflicted++;
    else if (row.verdict === "changes_requested") pile.changesAsked++;
    else if (row.verdict === "approved") pile.approved++;
    else pile.awaitingReview++;
  }
  return { ...pile, total: rows.length };
}

/** One sentence for /boards and the terminal; the order is the order a pull is sorted in, so the first pile named is the one it is counted in. */
export function pileSays(pile: Pile): string {
  if (pile.total === 0) return "No open crew pulls.";
  return `${pile.total} open crew ${pile.total === 1 ? "pull" : "pulls"}, each counted once in the first pile it fits: ${pile.red} red, ${pile.conflicted} conflicted, ${pile.changesAsked} changes asked, ${pile.approved} approved and waiting, ${pile.awaitingReview} awaiting review.`;
}

/** What a waiting pull waits on: its latest verdict decides (a bare comment is no verdict). */
export type WaitsOn = "a reviewer" | "a builder" | "the merge";

export interface Waiting {
  readonly ref: string;
  readonly on: WaitsOn;
}

/**
 * The oldest open crew pulls that wait on a person or a reviewer (not red,
 * not conflicted), each with what it waits on: no verdict waits on a
 * reviewer, changes requested on a builder, approved on the merge. A filed
 * "waiting" issue names them so whoever picks it up knows which act is theirs.
 * Private repositories are left out unless `publicOnly` is false.
 */
export function oldestWaitingOn(db: Database, limit: number, publicOnly = true): Waiting[] {
  const rows = db
    .query<{ repo: string; number: number; verdict: string | null }, [number]>(
      `SELECT o.username || '/' || r.name AS repo, i.number AS number,
              (SELECT v.state FROM review v WHERE v.issue_id = i.id AND v.state IN ('approved','changes_requested')
                  ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS verdict
         FROM issue i JOIN pull p ON p.issue_id = i.id JOIN repo r ON r.id = i.repo_id
         JOIN user o ON o.id = r.owner_id JOIN user a ON a.id = i.author_id
        WHERE i.state = 'open' AND p.merged_at IS NULL AND (?1 = 0 OR r.visibility = 'public')
          AND a.is_agent = 1 AND COALESCE(i.origin_author, '') = ''
          AND EXISTS (SELECT 1 FROM repo_crew c WHERE c.repo_id = r.id AND c.user_id = a.id)
          AND NOT COALESCE((SELECT c.state FROM run c WHERE c.kind = 'check' AND c.issue_id = i.id
                              AND c.commit_oid = p.head_oid ORDER BY c.id DESC LIMIT 1) = 'failed', 0)
        ORDER BY i.created_at ASC, i.id ASC`,
    )
    .all(publicOnly ? 1 : 0);
  const conflicted = new Set(conflictedPulls(db, publicOnly).map((p) => `${p.repo}#${p.number}`));
  const cap = Math.max(0, Math.floor(limit));
  const out: Waiting[] = [];
  if (cap === 0) return out;
  for (const r of rows) {
    const ref = `${r.repo}#${r.number}`;
    if (conflicted.has(ref)) continue;
    out.push({ ref, on: r.verdict === "approved" ? "the merge" : r.verdict === "changes_requested" ? "a builder" : "a reviewer" });
    if (out.length >= cap) break;
  }
  return out;
}
