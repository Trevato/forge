/**
 * What one account's crew may spend on a model: a ceiling per UTC day and a
 * ceiling per run, apart from the forge-wide one. An account has none until
 * an admin sets them — a person's, an agent's or an organization's — so a
 * forge's own crew is never stopped by a default nobody chose. Spend is counted from the
 * usage ledger over the account's own repositories, so another account's
 * spend never counts here. A run reserves its budget against the day when
 * it starts (`reserveCeiling`), so runs started together are counted
 * together. Pure data; who may set is the action's to decide.
 */

import type { Database } from "bun:sqlite";

/** The most either ceiling may be, in dollars. */
export const CEILING_MAX_USD = 10_000;

export interface AccountCeiling {
  readonly dailyUsd: number;
  readonly perRunUsd: number;
}

export const dayStart = (now: Date): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

/** Whole cents, above zero and within the maximum. */
export const validCeiling = (usd: number): boolean =>
  Number.isFinite(usd) && usd >= 0.01 && usd <= CEILING_MAX_USD;

/** The ceilings an admin set, or undefined: no ceiling. */
export function getAccountCeiling(db: Database, userId: string): AccountCeiling | undefined {
  const row = db
    .query<{ daily_usd: number; per_run_usd: number }, [string]>(
      "SELECT daily_usd, per_run_usd FROM account_ceiling WHERE user_id = ?1",
    )
    .get(userId);
  return row ? { dailyUsd: row.daily_usd, perRunUsd: row.per_run_usd } : undefined;
}

/** Dollars rounded to whole cents. */
export const cents = (n: number): number => Math.round(n * 100) / 100;

/** Take the ceilings back: the account has none again. */
export function clearAccountCeiling(db: Database, userId: string): void {
  db.query("DELETE FROM account_ceiling WHERE user_id = ?1").run(userId);
}

/** Set both ceilings. False when either is not a valid amount. */
export function setAccountCeiling(
  db: Database,
  userId: string,
  dailyUsd: number,
  perRunUsd: number,
  by: string,
  now: Date,
): boolean {
  if (!validCeiling(dailyUsd) || !validCeiling(perRunUsd)) return false;
  db.query(
    `INSERT INTO account_ceiling (user_id, daily_usd, per_run_usd, set_by, set_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(user_id) DO UPDATE SET daily_usd = ?2, per_run_usd = ?3, set_by = ?4, set_at = ?5`,
  ).run(userId, cents(dailyUsd), cents(perRunUsd), by, now.toISOString());
  return true;
}

/** What the account's repositories and conversation have spent today (UTC), running runs included. */
export function daySpent(db: Database, userId: string, now: Date): number {
  return (
    db
      .query<{ n: number }, [string, string]>(
        `SELECT COALESCE((SELECT SUM(u.cost_usd) FROM usage u JOIN repo r ON r.id = u.repo_id
                          WHERE r.owner_id = ?1 AND u.at >= ?2), 0)
              + COALESCE((SELECT SUM(c.cost_usd) FROM conversation_run c
                          WHERE c.user_id = ?1 AND c.started_at >= ?2), 0) AS n`,
      )
      .get(userId, dayStart(now))?.n ?? 0
  );
}

/** Dollars left today, or undefined when the account has no ceiling. */
export function dailyLeft(db: Database, userId: string, now: Date): number | undefined {
  const c = getAccountCeiling(db, userId);
  return c === undefined ? undefined : Math.max(0, c.dailyUsd - daySpent(db, userId, now));
}

export type CeilingVerdict =
  | { readonly ok: true; readonly capUsd: number | undefined }
  | { readonly ok: false; readonly said: string };

/**
 * What the account's other runs still queued or running have reserved of
 * the day and not spent yet. Never `runId`'s own, which it is reserving now.
 */
function reservedByOthers(db: Database, userId: string, runId: string): number {
  return (
    db
      .query<{ n: number }, [string, string]>(
        `SELECT COALESCE(SUM(MAX(0, r.ceiling_reserved_usd -
            (SELECT COALESCE(SUM(u.cost_usd), 0) FROM usage u WHERE u.run_id = r.id))), 0) AS n
         FROM run r JOIN repo p ON p.id = r.repo_id
         WHERE p.owner_id = ?1 AND r.state IN ('queued', 'running')
           AND r.id <> ?2 AND r.ceiling_reserved_usd IS NOT NULL`,
      )
      .get(userId, runId)?.n ?? 0
  );
}

/**
 * May a run start for this account, and with what cap: the smaller of its
 * per-run ceiling, what it wants, and what is left of today once the other
 * runs under way have their reservations. That cap is reserved for the run
 * in the same transaction, so the next run already counts it; the
 * reservation goes when the run leaves `queued`/`running`. A refusal names
 * the ceiling.
 */
export function reserveCeiling(
  db: Database,
  userId: string,
  run: { readonly id: string; readonly wantUsd: number },
  minRunUsd: number,
  now: Date,
): CeilingVerdict {
  return db.transaction((): CeilingVerdict => {
    const c = getAccountCeiling(db, userId);
    if (c === undefined) return { ok: true, capUsd: undefined };
    if (c.perRunUsd < minRunUsd)
      return {
        ok: false,
        said: `This account's per-run ceiling ($${c.perRunUsd.toFixed(2)}) is too small to start a run: an admin can raise it`,
      };
    const left = Math.max(0, c.dailyUsd - daySpent(db, userId, now) - reservedByOthers(db, userId, run.id));
    if (left < minRunUsd)
      return {
        ok: false,
        said: `This account's daily ceiling ($${c.dailyUsd.toFixed(2)}) is spent for today: an admin can raise it`,
      };
    const capUsd = Math.min(c.perRunUsd, left, run.wantUsd);
    db.query("UPDATE run SET ceiling_reserved_usd = ?1 WHERE id = ?2").run(capUsd, run.id);
    return { ok: true, capUsd };
  })();
}
