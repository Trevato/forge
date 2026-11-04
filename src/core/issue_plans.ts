/**
 * An issue's plan: the short checklist a crew run keeps so a person sees where
 * it is without reading a log (#8707). Replaced whole at each update, never
 * appended to; bounded in count and length, and every field checked before it
 * is kept. Pure data over the database: no authz, no events.
 */

import type { Database } from "bun:sqlite";

export const PLAN_ITEMS_MAX = 12;
export const PLAN_TEXT_MAX = 120;
export const PLAN_ASK_MAX = 300;

export interface PlanItem {
  readonly text: string;
  readonly done: boolean;
}

export interface IssuePlan {
  readonly issueId: string;
  readonly runId: string | null;
  readonly items: readonly PlanItem[];
  /** What the run needs a person to answer; empty when it needs nothing. */
  readonly ask: string;
  readonly updatedAt: string;
}

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The items a caller sent, as a checklist; undefined when the shape is wrong. */
export function parseItems(raw: unknown): PlanItem[] | undefined {
  if (!Array.isArray(raw) || raw.length > PLAN_ITEMS_MAX) return undefined;
  const out: PlanItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return undefined;
    const { text, done } = item as { text?: unknown; done?: unknown };
    if (typeof text !== "string" || (done !== undefined && typeof done !== "boolean")) return undefined;
    const line = oneLine(text, PLAN_TEXT_MAX);
    if (line === "") return undefined;
    out.push({ text: line, done: done === true });
  }
  return out;
}

/** Replace the issue's plan whole. An empty list clears it. */
export function setIssuePlan(
  db: Database,
  issueId: string,
  items: readonly PlanItem[],
  opts: { readonly runId?: string | null; readonly ask?: string; readonly now?: Date } = {},
): IssuePlan {
  const at = (opts.now ?? new Date()).toISOString();
  const ask = oneLine(opts.ask ?? "", PLAN_ASK_MAX);
  db.query(
    `INSERT INTO issue_plan (issue_id, run_id, items, ask, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(issue_id) DO UPDATE SET run_id = ?2, items = ?3, ask = ?4, updated_at = ?5`,
  ).run(issueId, opts.runId ?? null, JSON.stringify(items), ask, at);
  return { issueId, runId: opts.runId ?? null, items, ask, updatedAt: at };
}

export function getIssuePlan(db: Database, issueId: string): IssuePlan | undefined {
  const r = db
    .query<{ run_id: string | null; items: string; ask: string; updated_at: string }, [string]>(
      "SELECT run_id, items, ask, updated_at FROM issue_plan WHERE issue_id = ?1",
    )
    .get(issueId);
  if (r === null) return undefined;
  return { issueId, runId: r.run_id, items: JSON.parse(r.items) as PlanItem[], ask: r.ask, updatedAt: r.updated_at };
}

/** The plans of several issues in one read, keyed by issue id. */
export function getIssuePlans(db: Database, issueIds: readonly string[]): Map<string, IssuePlan> {
  const out = new Map<string, IssuePlan>();
  for (let i = 0; i < issueIds.length; i += 200) {
    const part = issueIds.slice(i, i + 200);
    const rows = db
      .query<{ issue_id: string; run_id: string | null; items: string; ask: string; updated_at: string }, string[]>(
        `SELECT issue_id, run_id, items, ask, updated_at FROM issue_plan WHERE issue_id IN (${part.map(() => "?").join(",")})`,
      )
      .all(...part);
    for (const r of rows)
      out.set(r.issue_id, { issueId: r.issue_id, runId: r.run_id, items: JSON.parse(r.items) as PlanItem[], ask: r.ask, updatedAt: r.updated_at });
  }
  return out;
}
