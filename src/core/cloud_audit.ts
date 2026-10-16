/**
 * The cloud audit: one row per vendor call or hand-out, allowed or refused
 * (`cloud/gate.ts` writes it). Rows older than `KEEP_DAYS` are pruned on
 * write, so the table cannot grow without bound; `at` is indexed. A row
 * names the account and the host and path called — never a token, never a
 * query string.
 */

import type { Database } from "bun:sqlite";

export const KEEP_DAYS = 90;

export interface AuditRow {
  readonly id: number;
  readonly at: string;
  readonly provider: string;
  readonly account: string;
  readonly purpose: string;
  readonly target: string;
  readonly bytesOut: number;
  readonly allowed: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function recordAudit(
  db: Database,
  row: Omit<AuditRow, "id" | "at">,
  now: number = Date.now(),
): void {
  db.query(
    `INSERT INTO cloud_audit (at, provider, account, purpose, target, bytes_out, allowed)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(
    iso(now),
    row.provider,
    row.account,
    row.purpose.slice(0, 80),
    row.target.slice(0, 200),
    Math.max(0, Math.floor(row.bytesOut)),
    row.allowed ? 1 : 0,
  );
  pruneAudit(db, now);
}

/** Drop rows older than 90 days; the `at` index makes it a range delete. */
export function pruneAudit(db: Database, now: number = Date.now()): number {
  return db
    .query("DELETE FROM cloud_audit WHERE at < ?1")
    .run(iso(now - KEEP_DAYS * 86_400_000)).changes;
}

/** Rows since the start of the UTC day of `now`, newest first. */
export function auditToday(
  db: Database,
  now: number = Date.now(),
  limit = 500,
): AuditRow[] {
  const day = iso(now).slice(0, 10);
  return db
    .query<
      {
        id: number;
        at: string;
        provider: string;
        account: string;
        purpose: string;
        target: string;
        bytes_out: number;
        allowed: number;
      },
      [string, number]
    >(
      "SELECT * FROM cloud_audit WHERE at >= ?1 ORDER BY at DESC, id DESC LIMIT ?2",
    )
    .all(`${day}T00:00:00.000Z`, limit)
    .map((r) => ({
      id: r.id,
      at: r.at,
      provider: r.provider,
      account: r.account,
      purpose: r.purpose,
      target: r.target,
      bytesOut: r.bytes_out,
      allowed: r.allowed === 1,
    }));
}
