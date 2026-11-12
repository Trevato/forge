/**
 * What a hosted forge's owner lets the crew spend (#11515): a limit per run,
 * per UTC day and per UTC month, in dollars and cents, kept as forge settings
 * and counted from the usage ledger. They bind only a forge that is somebody's
 * own (a hosted child, `parent.json` in its data directory); the forge that
 * hosts others sets its spend through the account ceilings instead. Pure
 * data: who may set is the action's to decide.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { monthStart } from "../core/model_grant.ts";
import { dayStart } from "../core/account_ceiling.ts";
import { MIN_RUN_USD } from "../core/subscriptions.ts";
import { writeSetting } from "../settings/limits.ts";

export type BudgetKey = "run" | "day" | "month";
export const BUDGET_KEYS: readonly BudgetKey[] = ["run", "day", "month"];

/** Sensible for a key the owner pays for: a run is never cut off under a dollar. */
export const BUDGET_DEFAULT_USD: Record<BudgetKey, number> = { run: 5, day: 50, month: 500 };
export const BUDGET_MAX_USD = 100_000;
export const BUDGET_LABEL: Record<BudgetKey, string> = { run: "per run", day: "per day", month: "per month" };
/** Where the limits are set, and where a stop names them. */
export const BUDGETS_AT = "/settings/crew#budgets";

const storeKey = (key: BudgetKey): string => `crew.${key}_usd`;

/** Whole cents, above zero, within the maximum. */
export const validBudget = (usd: number): boolean =>
  Number.isFinite(usd) && usd >= 0.01 && usd <= BUDGET_MAX_USD && Math.abs(usd * 100 - Math.round(usd * 100)) < 1e-6;

/** Whether this forge is somebody's own: its host's file is in its data directory. */
export const isOwnForge = (app: App): boolean => existsSync(join(app.config.dataDir, "parent.json"));

export function budgetLimit(db: Database, key: BudgetKey): number {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1").get(storeKey(key));
  const n = row === null ? NaN : Number(row.value);
  return validBudget(n) ? n : BUDGET_DEFAULT_USD[key];
}

/** Set one limit; false when the amount is not valid. */
export function setBudget(db: Database, key: BudgetKey, usd: number, actorId: string): boolean {
  if (!validBudget(usd)) return false;
  const from = budgetLimit(db, key);
  const to = String(Math.round(usd * 100) / 100);
  writeSetting(db, storeKey(key), to, String(from), to, actorId);
  return true;
}

/** What the forge's agent runs have spent since `since`, from the usage ledger (`usage_at`). Conversations are not counted. */
export function spentSince(db: Database, since: string): number {
  return db.query<{ n: number }, [string]>("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM usage WHERE at >= ?1").get(since)?.n ?? 0;
}

export interface BudgetLine {
  readonly key: BudgetKey;
  readonly limitUsd: number;
  /** Spent against it: nothing for the per-run limit, which is not a total. */
  readonly spentUsd: number | undefined;
}

export function budgetLines(db: Database, now: Date): BudgetLine[] {
  return [
    { key: "run", limitUsd: budgetLimit(db, "run"), spentUsd: undefined },
    { key: "day", limitUsd: budgetLimit(db, "day"), spentUsd: spentSince(db, dayStart(now)) },
    { key: "month", limitUsd: budgetLimit(db, "month"), spentUsd: spentSince(db, monthStart(now)) },
  ];
}

export type BudgetVerdict =
  | { readonly ok: true; readonly capUsd: number; readonly by: BudgetKey | undefined }
  | { readonly ok: false; readonly said: string; readonly limit: BudgetKey };

const dollars = (n: number): string => `$${n.toFixed(2)}`;

/** The words a run is stopped with for want of a key; the runner says them and `wake.ts` reads them. */
export const NO_KEY_SAID = "This forge has no model key: add yours at /settings/crew";
export const NO_ACCOUNT_SAID = "This repository has no model account: ask an admin to grant one";
/** A stop by one of the owner's limits, as `stoppedBy` writes it. */
const LIMIT_STOP = /This forge's per (run|day|month) limit \(\$[\d.]+\) stopped the run/;
export const isLimitStop = (reason: string): boolean => LIMIT_STOP.test(reason);

/** The words for a stop by `key`, naming it and where to change it. */
export function stoppedBy(db: Database, key: BudgetKey): string {
  return `This forge's ${BUDGET_LABEL[key]} limit (${dollars(budgetLimit(db, key))}) stopped the run: raise it at ${BUDGETS_AT}`;
}

/** What a run's summary ends with when it was cut off at the cap and a limit of the owner's set that cap; nothing otherwise. */
export function cutOffBy(db: Database, own: BudgetVerdict | undefined, cutOff: boolean): string {
  return cutOff && own?.ok === true && own.by !== undefined ? ` — ${stoppedBy(db, own.by)}` : "";
}

/** What the other runs queued or running have reserved of the day and month and not spent yet. */
function reservedByOthers(db: Database, runId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT COALESCE(SUM(MAX(0, r.ceiling_reserved_usd -
            (SELECT COALESCE(SUM(u.cost_usd), 0) FROM usage u WHERE u.run_id = r.id))), 0) AS n
         FROM run r WHERE r.state IN ('queued', 'running') AND r.id <> ?1 AND r.ceiling_reserved_usd IS NOT NULL`,
      )
      .get(runId)?.n ?? 0
  );
}

/**
 * May a run start under the owner's limits, and with what cap. Undecided on
 * a forge that hosts others. With `runId`, the cap is reserved for that run
 * in the same transaction, and runs under way count against the day and the
 * month, so agents that start together share what is left rather than each
 * being handed all of it.
 */
export function budgetVerdict(app: App, wantUsd: number, now: Date, runId?: string): BudgetVerdict | undefined {
  if (!isOwnForge(app)) return undefined;
  return app.db.transaction((): BudgetVerdict => verdict(app, wantUsd, now, runId))();
}

function verdict(app: App, wantUsd: number, now: Date, runId: string | undefined): BudgetVerdict {
  const lines = budgetLines(app.db, now);
  const others = runId === undefined ? 0 : reservedByOthers(app.db, runId);
  const run = lines[0]!;
  if (run.limitUsd < MIN_RUN_USD) return { ok: false, limit: "run", said: stoppedBy(app.db, "run") };
  let cap = Math.min(wantUsd, run.limitUsd);
  let by: BudgetKey | undefined = run.limitUsd < wantUsd ? "run" : undefined;
  for (const line of lines.slice(1)) {
    const left = line.limitUsd - (line.spentUsd ?? 0) - others;
    if (left < MIN_RUN_USD) return { ok: false, limit: line.key, said: stoppedBy(app.db, line.key) };
    if (left < cap) by = line.key;
    cap = Math.min(cap, left);
  }
  if (runId !== undefined) app.db.query("UPDATE run SET ceiling_reserved_usd = ?1 WHERE id = ?2").run(cap, runId);
  return { ok: true, capUsd: cap, by };
}
