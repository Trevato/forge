/**
 * Per-account quotas — how much one account may own. Stored in
 * `forge_setting` under `quota.<key>`, and every change is kept in
 * `forge_setting_change` (who, when, from what to what). The default for
 * each is no limit (`null`), and creating an app asks the apps limit
 * (`actions/app_limit.ts`); repositories are not enforced yet. Room for more keys is the `QUOTA_KEYS` list.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { writeSetting } from "./limits.ts";

export const QUOTA_KEYS = ["repositories", "apps"] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];
export type Quotas = Record<QuotaKey, number | null>;

const MAX = 1_000_000_000;

export function isQuotaKey(key: string): key is QuotaKey {
  return (QUOTA_KEYS as readonly string[]).includes(key);
}

const storeKey = (key: QuotaKey): string => `quota.${key}`;

/** A limit from untrusted input: a positive integer, or empty/null for none. */
export function parseQuota(raw: unknown): Result<number | null, "invalid_quota"> {
  if (raw === null || raw === undefined) return ok(null);
  if (typeof raw === "number")
    return Number.isInteger(raw) && raw >= 1 && raw <= MAX ? ok(raw) : err("invalid_quota");
  if (typeof raw !== "string") return err("invalid_quota");
  const s = raw.trim();
  if (s === "") return ok(null);
  if (!/^\d{1,10}$/.test(s)) return err("invalid_quota");
  const n = Number(s);
  return n >= 1 && n <= MAX ? ok(n) : err("invalid_quota");
}

export function getQuota(db: Database, key: QuotaKey): number | null {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
    .get(storeKey(key));
  if (row === null) return null;
  const parsed = parseQuota(row.value);
  return parsed.ok ? parsed.value : null;
}

export function getQuotas(db: Database): Quotas {
  return { repositories: getQuota(db, "repositories"), apps: getQuota(db, "apps") };
}

/** Set `key` (`null` clears it) and keep the change. */
export function setQuota(
  db: Database,
  key: QuotaKey,
  value: number | null,
  actorId: string,
): void {
  const from = getQuota(db, key);
  if (from === value) return;
  writeSetting(
    db,
    storeKey(key),
    value === null ? null : String(value),
    from === null ? "" : String(from),
    value === null ? "" : String(value),
    actorId,
  );
}

export interface QuotaChange {
  readonly key: QuotaKey;
  readonly from: string;
  readonly to: string;
  readonly actorName: string;
  readonly at: string;
}

/** The most recent quota changes, newest first. An empty value is no limit. */
export function quotaChanges(db: Database, limit = 20): QuotaChange[] {
  return db
    .query<
      { key: string; from_value: string; to_value: string; username: string | null; at: string },
      []
    >(
      `SELECT c.key, c.from_value, c.to_value, u.username, c.at
         FROM forge_setting_change c LEFT JOIN user u ON u.id = c.actor_id
        WHERE c.key LIKE 'quota.%'
        ORDER BY c.at DESC, c.rowid DESC
        LIMIT ${Math.trunc(limit)}`,
    )
    .all()
    .filter((r) => isQuotaKey(r.key.slice(6)))
    .map((r) => ({
      key: r.key.slice(6) as QuotaKey,
      from: r.from_value,
      to: r.to_value,
      actorName: r.username ?? "",
      at: r.at,
    }));
}
