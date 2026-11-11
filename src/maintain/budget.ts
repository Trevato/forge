/**
 * A duty's budget (#11206): runs per day and dollars per day, each a setting an admin moves on
 * /maintenance with the duty's reason beside it, never a constant. The duty declares the
 * default and why; a stored value (`forge_setting`, key `maintain.<duty>.runs|dollars`) wins.
 * The day is the UTC day. Plain data in, plain data out.
 */

import type { Database } from "bun:sqlite";
import type { Duty } from "./duty.ts";

export const RUNS_MAX = 100_000;
export const DOLLARS_MIN = 0.01;
export const DOLLARS_MAX = 10_000;

export type BudgetKind = "runs" | "dollars";

export interface Budget {
  readonly runsPerDay: number;
  readonly dollarsPerDay: number;
}

export const settingKey = (duty: string, kind: BudgetKind): string => `maintain.${duty}.${kind}`;

/** The number `text` is, when it is a value the budget `kind` takes. */
export function parseBudget(kind: BudgetKind, text: string): number | undefined {
  const t = text.trim();
  if (kind === "runs") {
    if (!/^\d{1,6}$/.test(t)) return undefined;
    const n = Number(t);
    return n >= 1 && n <= RUNS_MAX ? n : undefined;
  }
  if (!/^\d{1,5}(\.\d{1,4})?$/.test(t)) return undefined;
  const n = Number(t);
  return n >= DOLLARS_MIN && n <= DOLLARS_MAX ? n : undefined;
}

function stored(db: Database, duty: string, kind: BudgetKind): number | undefined {
  const row = db.query("SELECT value FROM forge_setting WHERE key = ?1").get(settingKey(duty, kind)) as { value: string } | null;
  return row === null ? undefined : parseBudget(kind, row.value);
}

const declared = (duty: Duty, kind: BudgetKind): number => (kind === "runs" ? duty.budget.runsPerDay : duty.budget.dollarsPerDay);

/** The budget in force for a duty: stored values over the duty's declared ones. Read on every tick. */
export function budgetOf(db: Database, duty: Duty): Budget {
  return {
    runsPerDay: stored(db, duty.name, "runs") ?? duty.budget.runsPerDay,
    dollarsPerDay: stored(db, duty.name, "dollars") ?? duty.budget.dollarsPerDay,
  };
}

/** Keep a new value for a budget (`null`, or the duty's own number, goes back to the duty's own), and who moved it. */
export function setBudget(db: Database, duty: Duty, kind: BudgetKind, given: number | null, actorId: string): void {
  // Only a value that differs from the declared one is stored, so a later change of the default still takes.
  const value = given === declared(duty, kind) ? null : given;
  const key = settingKey(duty.name, kind);
  const from = String(stored(db, duty.name, kind) ?? declared(duty, kind));
  const at = new Date().toISOString();
  db.transaction(() => {
    if (value === null) db.query("DELETE FROM forge_setting WHERE key = ?1").run(key);
    else
      db.query(
        `INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).run(key, String(value), actorId, at);
    const to = String(stored(db, duty.name, kind) ?? declared(duty, kind));
    db.query("INSERT INTO forge_setting_change (key, from_value, to_value, actor_id, at, reason) VALUES (?1, ?2, ?3, ?4, ?5, '')").run(key, from, to, actorId, at);
  })();
}

/** The UTC day `now` falls in, as ISO bounds. */
export function dayBounds(now: Date): { from: string; to: string } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: new Date(start).toISOString(), to: new Date(start + 86_400_000).toISOString() };
}

/** What a duty has used today: real runs (a budget stop is not one) and dollars. */
export function usedToday(db: Database, duty: string, now: Date): { runs: number; dollars: number } {
  const { from, to } = dayBounds(now);
  return db
    .query("SELECT COUNT(*) AS runs, COALESCE(SUM(dollars), 0) AS dollars FROM maintenance_run WHERE duty = ?1 AND started >= ?2 AND started < ?3 AND outcome NOT LIKE 'budget:%'")
    .get(duty, from, to) as { runs: number; dollars: number };
}

/** The outcome that names the budget a duty stopped at; undefined while it is within both. */
export function overBudget(db: Database, duty: Duty, now: Date): string | undefined {
  const b = budgetOf(db, duty);
  const used = usedToday(db, duty.name, now);
  if (used.runs >= b.runsPerDay) return `budget: runs per day, ${used.runs} of ${b.runsPerDay} used`;
  if (used.dollars >= b.dollarsPerDay) return `budget: dollars per day, $${used.dollars.toFixed(2)} of $${b.dollarsPerDay.toFixed(2)} spent`;
  return undefined;
}

/** Whether today already has a stop row of this kind for the duty, so a stop is said once a day. */
export function stoppedToday(db: Database, duty: string, outcome: string, now: Date): boolean {
  const { from, to } = dayBounds(now);
  const prefix = `${outcome.slice(0, outcome.indexOf(","))}%`;
  return db.query("SELECT 1 FROM maintenance_run WHERE duty = ?1 AND started >= ?2 AND started < ?3 AND outcome LIKE ?4 LIMIT 1").get(duty, from, to, prefix) !== null;
}
