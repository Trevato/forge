/**
 * Per-account quotas — how much one account may own. Stored in
 * `forge_setting` under `quota.<key>`, and every change is kept in
 * `forge_setting_change` (who, when, from what to what). The default for
 * each is no limit (`null`), and creating an app asks the apps limit
 * (`actions/app_limit.ts`); creating, forking and copying a repository ask the
 * repositories limit first (`actions/repos.ts`). `storage` is megabytes
 * of repositories plus app data (`core/storage.ts`), asked on a push, create
 * and fork. The running limits — live `previews`, concurrent agent `runs` and
 * concurrent `checks` — bound what an account has going at once; each is asked
 * before the thing starts (`apps/runtime.ts`, `crew/dispatch.ts`,
 * `checks/service.ts`) and never of a forge admin. Room for more keys is the
 * `QUOTA_KEYS` list.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { writeSetting } from "./limits.ts";

export const QUOTA_KEYS = ["repositories", "apps", "storage", "previews", "runs", "checks"] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];
export type Quotas = Record<QuotaKey, number | null>;

const MAX = 1_000_000_000;

export function isQuotaKey(key: string): key is QuotaKey {
  return (QUOTA_KEYS as readonly string[]).includes(key);
}

/**
 * What an account that came through a request (`core/requests.ts`) is held
 * to when the admin has set no limit of their own: small, so that letting a
 * stranger in costs little. Admins, existing members and guests who never
 * asked are not in it; a stored quota is the admin's word and wins.
 */
export const NEWCOMER_QUOTAS: Quotas = {
  repositories: 3,
  apps: 2,
  storage: 200,
  previews: 1,
  runs: 1,
  checks: 1,
};

/** The limit on `key` for the account `ownerId`: the stored one, else the newcomer's, else none. */
export function quotaOf(db: Database, key: QuotaKey, ownerId: string): number | null {
  const stored = getQuota(db, key);
  if (stored !== null) return stored;
  const asked = db.query("SELECT 1 FROM account_request WHERE user_id = ?1 AND state = 'allowed'").get(ownerId);
  return asked === null ? null : NEWCOMER_QUOTAS[key];
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
  return {
    repositories: getQuota(db, "repositories"),
    apps: getQuota(db, "apps"),
    storage: getQuota(db, "storage"),
    previews: getQuota(db, "previews"),
    runs: getQuota(db, "runs"),
    checks: getQuota(db, "checks"),
  };
}

/** Repositories an account owns, a sealed fork (nobody's to count) aside. */
export function repositoriesOwned(db: Database, ownerId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM repo WHERE owner_id = ?1 AND sealed_for IS NULL",
      )
      .get(ownerId)?.n ?? 0
  );
}

/** The sentence a refused creation says, or nothing when there is room. */
export function repositoryLimitSentence(db: Database, ownerId: string): string | undefined {
  const limit = quotaOf(db, "repositories", ownerId);
  if (limit === null) return undefined;
  const owned = repositoriesOwned(db, ownerId);
  return owned >= limit ? `${owned} of ${limit} repositories` : undefined;
}

/** Whether `ownerId` is a forge admin: the forge's own account is never limited. */
function exempt(db: Database, ownerId: string): boolean {
  return (
    db
      .query<{ is_admin: number }, [string]>("SELECT is_admin FROM user WHERE id = ?1")
      .get(ownerId)?.is_admin === 1
  );
}

/**
 * The sentence a refused start says, or nothing when there is room: `held`
 * is how many of `noun` ("live previews", "runs", "checks") the account
 * has going now, asked against the `key` limit.
 */
export function runningLimitSentence(
  db: Database,
  key: "previews" | "runs" | "checks",
  noun: string,
  ownerId: string,
  held: () => number,
): string | undefined {
  const limit = quotaOf(db, key, ownerId);
  if (limit === null || exempt(db, ownerId)) return undefined;
  const n = held();
  return n >= limit ? `${n} of ${limit} ${noun}` : undefined;
}

/**
 * Runs of `kind` running now for repositories `ownerId` owns, plus the
 * `also` ids (started a moment ago, not yet claimed in the database).
 */
export function runningRuns(
  db: Database,
  kind: "agent" | "check",
  ownerId: string,
  also: Iterable<string> = [],
): number {
  const ids = new Set(
    db
      .query<{ id: string }, [string, string]>(
        `SELECT run.id FROM run JOIN repo ON repo.id = run.repo_id
          WHERE run.kind = ?1 AND run.state = 'running' AND repo.owner_id = ?2`,
      )
      .all(kind, ownerId)
      .map((r) => r.id),
  );
  for (const id of also) {
    const row = db
      .query<{ owner_id: string }, [string, string]>(
        `SELECT repo.owner_id FROM run JOIN repo ON repo.id = run.repo_id
          WHERE run.id = ?1 AND run.kind = ?2`,
      )
      .get(id, kind);
    if (row?.owner_id === ownerId) ids.add(id);
  }
  return ids.size;
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
