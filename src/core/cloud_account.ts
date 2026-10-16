/**
 * Cloud accounts — the rows around a sealed provider credential. The value
 * lives in `secret` (core/secret_store.ts) at forge scope under
 * `CLOUD_<PROVIDER>_<NAME>` (a secret name is capitals, so `cloudflare/main`
 * is stored as `CLOUD_CLOUDFLARE_MAIN`); this table holds what is safe to
 * show: when it was last verified, what the check said, and whether runs
 * may write with it. Write is off until someone turns it on.
 */

import type { Database } from "bun:sqlite";
import { isProvider, type Provider } from "../cloud/providers.ts";

const made = new WeakSet<Database>();
function table(db: Database): void {
  if (made.has(db)) return;
  db.run(`CREATE TABLE IF NOT EXISTS cloud_account (
    provider      TEXT NOT NULL,
    name          TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    verified_at   TEXT,
    write_allowed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, name)
  )`);
  made.add(db);
}

export const CLOUD_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const PREFIX = "CLOUD_";

export const secretNameOf = (provider: Provider, name: string): string =>
  `${PREFIX}${provider.toUpperCase()}_${name.toUpperCase()}`;

/** The provider and name a secret name stands for, if it is a cloud one. */
export function accountOfSecret(
  secret: string,
): { provider: Provider; name: string } | undefined {
  if (!secret.startsWith(PREFIX)) return undefined;
  const rest = secret.slice(PREFIX.length);
  const i = rest.indexOf("_");
  const provider = rest.slice(0, i).toLowerCase();
  const name = rest.slice(i + 1).toLowerCase();
  return i > 0 && isProvider(provider) && name !== ""
    ? { provider, name }
    : undefined;
}

export interface CloudAccount {
  readonly provider: Provider;
  readonly name: string;
  readonly summary: string;
  readonly verifiedAt: string | null;
  readonly writeAllowed: boolean;
}

interface Row {
  provider: string;
  name: string;
  summary: string;
  verified_at: string | null;
  write_allowed: number;
}

const toAccount = (r: Row): CloudAccount => ({
  provider: r.provider as Provider,
  name: r.name,
  summary: r.summary,
  verifiedAt: r.verified_at,
  writeAllowed: r.write_allowed === 1,
});

export function listCloudAccounts(db: Database): CloudAccount[] {
  table(db);
  return db
    .query<Row, []>("SELECT * FROM cloud_account ORDER BY provider, name")
    .all()
    .map(toAccount);
}

export function getCloudAccount(
  db: Database,
  provider: string,
  name: string,
): CloudAccount | undefined {
  table(db);
  const r = db
    .query<Row, [string, string]>(
      "SELECT * FROM cloud_account WHERE provider = ?1 AND name = ?2",
    )
    .get(provider, name);
  return r ? toAccount(r) : undefined;
}

export function recordVerified(
  db: Database,
  provider: Provider,
  name: string,
  summary: string,
): void {
  table(db);
  db.query(
    `INSERT INTO cloud_account (provider, name, summary, verified_at)
     VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(provider, name) DO UPDATE SET
       summary = excluded.summary, verified_at = excluded.verified_at`,
  ).run(provider, name, summary.slice(0, 600));
}

export function setWriteAllowed(
  db: Database,
  provider: string,
  name: string,
  allowed: boolean,
): boolean {
  table(db);
  return (
    db
      .query(
        "UPDATE cloud_account SET write_allowed = ?3 WHERE provider = ?1 AND name = ?2",
      )
      .run(provider, name, allowed ? 1 : 0).changes > 0
  );
}

export function renameCloudAccount(
  db: Database,
  provider: string,
  name: string,
  to: string,
): void {
  table(db);
  db.query(
    "UPDATE cloud_account SET name = ?3 WHERE provider = ?1 AND name = ?2",
  ).run(provider, name, to);
}

export function forgetCloudAccount(
  db: Database,
  provider: string,
  name: string,
): void {
  table(db);
  db.query("DELETE FROM cloud_account WHERE provider = ?1 AND name = ?2").run(
    provider,
    name,
  );
}

/**
 * Whether a run that needs writes may hold this secret. A name that is not a
 * cloud credential is not this module's to gate; a cloud one with no row, or
 * with the switch off, is refused.
 */
export function writeRefused(db: Database, secret: string): boolean {
  const acct = accountOfSecret(secret);
  if (!acct) return false;
  return !getCloudAccount(db, acct.provider, acct.name)?.writeAllowed;
}

export interface CloudRead {
  readonly at: string;
  readonly provider: Provider;
  readonly name: string;
  readonly run: string | null;
}

/** Recent opens of cloud credentials, newest first, from the event outbox. */
export function recentCloudReads(db: Database, limit = 30): CloudRead[] {
  const rows = db
    .query<{ created_at: string; payload: string }, [number]>(
      `SELECT created_at, payload FROM event
       WHERE kind = 'secret.read'
         AND json_extract(payload, '$.name') LIKE 'CLOUD\\_%' ESCAPE '\\'
       ORDER BY id DESC LIMIT ?1`,
    )
    .all(limit);
  const out: CloudRead[] = [];
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { name: string; run: string | null };
    const acct = accountOfSecret(p.name);
    if (acct) out.push({ at: r.created_at, ...acct, run: p.run });
  }
  return out;
}
