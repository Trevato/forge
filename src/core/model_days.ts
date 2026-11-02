/**
 * Spend and landed pulls per model per day (#7570), so the switch from one
 * model to another is measured. A run counts on the day it was created, a
 * pull on the day it merged, under the model of the latest agent run on it.
 * An unrecorded model is the empty string.
 */
import type { Database } from "bun:sqlite";

export interface ModelDay {
  /** UTC date, `2026-10-27`. */
  readonly day: string;
  readonly model: string;
  readonly runs: number;
  readonly spentUsd: number;
  readonly landed: number;
}

/** The last `days` days, newest day first, then the model by name. */
export function modelDays(db: Database, days = 7, now = Date.now()): ModelDay[] {
  const since = new Date(now - days * 86_400_000).toISOString();
  const rows = new Map<string, { day: string; model: string; runs: number; spentUsd: number; landed: number }>();
  const at = (day: string, model: string) => {
    const key = `${day}\0${model}`;
    let row = rows.get(key);
    if (row === undefined) rows.set(key, (row = { day, model, runs: 0, spentUsd: 0, landed: 0 }));
    return row;
  };
  for (const r of db
    .query<{ day: string; model: string; runs: number; spent: number }, [string]>(
      `SELECT substr(created_at, 1, 10) AS day, model, COUNT(*) AS runs,
              COALESCE(SUM(cost_usd), 0) AS spent
         FROM run WHERE kind = 'agent' AND created_at >= ?1 GROUP BY day, model`,
    )
    .all(since)) {
    const row = at(r.day, r.model);
    row.runs = r.runs;
    row.spentUsd = r.spent;
  }
  for (const r of db
    .query<{ day: string; model: string; landed: number }, [string]>(
      `SELECT substr(pull.merged_at, 1, 10) AS day,
              COALESCE((SELECT run.model FROM run
                         WHERE run.issue_id = issue.id AND run.kind = 'agent'
                         ORDER BY run.id DESC LIMIT 1), '') AS model,
              COUNT(*) AS landed
         FROM pull JOIN issue ON issue.id = pull.issue_id
        WHERE pull.merged_at >= ?1 GROUP BY day, model`,
    )
    .all(since))
    at(r.day, r.model).landed = r.landed;
  return [...rows.values()].sort(
    (a, b) => b.day.localeCompare(a.day) || a.model.localeCompare(b.model),
  );
}
