/**
 * What /talk's turns cost and how full the context is (#8822), read from the
 * run's own usage record (`conversation_run`), never estimated.
 */

import type { Database } from "bun:sqlite";

/** The window assumed when a run did not report its model's. */
export const CONTEXT_TOKENS = 200_000;
/** From this share of the context a new conversation is suggested. */
export const FULL_AT = 0.8;

/** The dollars of the run that wrote each agent turn, by turn id: on the last agent turn inside the run's span. */
export function turnCosts(db: Database, conversationId: string): Map<string, number> {
  const rows = db
    .query<{ id: string; cost: number }, [string]>(
      `SELECT (SELECT t.id FROM conversation_turn t
                WHERE t.conversation_id = r.conversation_id AND t.role = 'agent'
                  AND t.created_at >= r.started_at AND t.created_at <= r.finished_at
                ORDER BY t.rowid DESC LIMIT 1) AS id, r.cost_usd AS cost
         FROM conversation_run r
        WHERE r.conversation_id = ?1 AND r.finished_at IS NOT NULL AND r.cost_usd > 0`,
    )
    .all(conversationId);
  const costs = new Map<string, number>();
  for (const r of rows) if (r.id !== null) costs.set(r.id, (costs.get(r.id) ?? 0) + r.cost);
  return costs;
}

export interface Context {
  readonly tokens: number;
  /** The model's window as its run reported it, else `CONTEXT_TOKENS`. */
  readonly window: number;
  readonly share: number;
}

/** How full the context was at the end of the latest turn, or undefined before any usage. */
export function contextOf(db: Database, conversationId: string): Context | undefined {
  const row = db
    .query<{ n: number; w: number }, [string]>(
      "SELECT context_tokens AS n, context_window AS w FROM conversation_run WHERE conversation_id = ?1 AND context_tokens > 0 ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(conversationId);
  if (row === null) return undefined;
  const window = row.w > 0 ? row.w : CONTEXT_TOKENS;
  return { tokens: row.n, window, share: Math.min(1, row.n / window) };
}

const thousands = (n: number): string => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

/** "Context 85% full (170k of 200k tokens)", with the nudge from `FULL_AT`. */
export const contextText = (c: Context): string =>
  `Context ${Math.round(c.share * 100)}% full (${thousands(c.tokens)} of ${thousands(c.window)} tokens)${c.share >= FULL_AT ? ". A new conversation answers faster and costs less" : ""}`;

/** Dollars as a quiet figure: cents below a dollar, a tenth of a cent below that. */
export const dollars = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`);
