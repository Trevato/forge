/**
 * An app's own domains — the rows. `app.example.com` is served by the forge
 * once the person who added it has shown they hold the name: a TXT record
 * carrying the token the row remembers. The token is published in DNS, so
 * it is not a secret; the proof is that only the zone's owner could put it
 * there. Pure data: no DNS, no authz, no events. What is published and how
 * it is checked is `apps/domains.ts`.
 */

import type { Database } from "bun:sqlite";
import type { EnvName } from "../apps/data.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface AppDomain {
  readonly host: string;
  readonly appId: string;
  /** The environment the host reaches — production, for now. */
  readonly env: EnvName;
  /** Published in DNS as `forge-verify=<token>`, to prove control of the name. */
  readonly token: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
  readonly checkedAt: string | null;
  /** What the last check said, one sentence for a person. */
  readonly said: string;
  /** The records the name carried before the cut-over: the way back. */
  readonly oldRecords: readonly OldRecord[];
}

/** One DNS record as the old host served it, written down before the cut. */
export interface OldRecord {
  readonly type: string;
  readonly name: string;
  readonly value: string;
  /** Seconds, when the old zone said. */
  readonly ttl?: number;
}

interface DomainRow {
  host: string;
  app_id: string;
  env: EnvName;
  token: string;
  created_by: string | null;
  created_at: string;
  verified_at: string | null;
  checked_at: string | null;
  said: string;
  old_records: string;
}

function parseOldRecords(text: string): OldRecord[] {
  try {
    const kept = parseRecordsInput(JSON.parse(text) as unknown);
    return kept.ok ? kept.value : [];
  } catch {
    return [];
  }
}

const RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "ALIAS", "TXT", "MX", "NS", "CAA", "SRV"]);
export const MAX_OLD_RECORDS = 50;

/**
 * Records written down by hand, checked at the boundary: a known type, a
 * name and a value of plain length, a TTL that is whole seconds. Anything
 * else is refused whole, so what is stored is what the owner meant.
 */
export function parseRecordsInput(input: unknown): Result<OldRecord[], "invalid_records"> {
  if (!Array.isArray(input) || input.length > MAX_OLD_RECORDS) return err("invalid_records");
  const out: OldRecord[] = [];
  for (const item of input) {
    if (typeof item !== "object" || item === null) return err("invalid_records");
    const r = item as Record<string, unknown>;
    const type = typeof r["type"] === "string" ? r["type"].trim().toUpperCase() : "";
    const name = typeof r["name"] === "string" ? r["name"].trim() : "";
    const value = typeof r["value"] === "string" ? r["value"].trim() : "";
    const ttl = r["ttl"];
    if (!RECORD_TYPES.has(type)) return err("invalid_records");
    if (name === "" || name.length > 253 || value === "" || value.length > 2048) return err("invalid_records");
    if (ttl !== undefined && (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0 || ttl > 2_147_483_647))
      return err("invalid_records");
    out.push(ttl === undefined ? { type, name, value } : { type, name, value, ttl });
  }
  return ok(out);
}

/** `A app.example.com 203.0.113.7 300; CNAME www.example.com host.example.net`: the terminal's way to type records. */
export function recordsFromLine(line: string): unknown[] {
  return line
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .filter((f) => f[0] !== "")
    .map(([type, name, value, ttl]) => ({ type, name, value, ...(ttl === undefined ? {} : { ttl: Number(ttl) }) }));
}

/** Keep the old records with the row, replacing what was kept. False when no such host. */
export function setOldRecords(db: Database, host: string, records: readonly OldRecord[]): boolean {
  return (
    db
      .query("UPDATE app_domain SET old_records = ?2 WHERE host = ?1")
      .run(normalizeHost(host), JSON.stringify(records)).changes > 0
  );
}

const toDomain = (r: DomainRow): AppDomain => ({
  host: r.host,
  appId: r.app_id,
  env: r.env,
  token: r.token,
  createdBy: r.created_by,
  createdAt: r.created_at,
  verifiedAt: r.verified_at,
  checkedAt: r.checked_at,
  said: r.said,
  oldRecords: parseOldRecords(r.old_records),
});

const now = (): string => new Date().toISOString();

/**
 * The names an app may not take: the forge's own hostname, and anything
 * that hangs off the app domain — those are the forge's to hand out
 * (`<slug>.<domain>`), and a row here would shadow them.
 */
export interface DomainRules {
  /** The forge's own hostname, lowercase. */
  readonly forgeHost: string;
  /** What app hostnames attach to (`appHostSuffix`), when apps are served. */
  readonly appHostSuffix?: string | undefined;
}

export type AddDomainError = "invalid_host" | "reserved_host" | "taken";

/** A hostname the way DNS wants it: lowercase, no trailing dot. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A hostname a person can own: at least two labels of letters, digits and
 * inside hyphens, and not an address. A last label of digits is an IPv4
 * literal or a name no URL can hold, and is refused either way.
 */
export function isHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)))
    return false;
  return !/^\d+$/.test(labels.at(-1)!);
}

function isReserved(host: string, rules: DomainRules): boolean {
  if (host === rules.forgeHost.toLowerCase()) return true;
  const suffix = rules.appHostSuffix?.toLowerCase();
  if (suffix === undefined) return false;
  // `.apps.example` and `--apps.example` both hang off `apps.example`.
  const zone = suffix.replace(/^[^a-z0-9]+/, "");
  return host === zone || host.endsWith(suffix) || host.endsWith(`.${zone}`);
}

/** 24 characters of Crockford base32 — 120 bits — for the TXT record. */
export const TOKEN_LENGTH = 24;
const TOKEN_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function newToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += TOKEN_ALPHABET[byte & 31];
  return out;
}

export function addDomain(
  db: Database,
  input: { host: string; appId: string; createdBy?: string | undefined },
  rules: DomainRules,
): Result<AppDomain, AddDomainError> {
  const host = normalizeHost(input.host);
  if (!isHostname(host)) return err("invalid_host");
  if (isReserved(host, rules)) return err("reserved_host");
  if (getDomain(db, host)) return err("taken");
  try {
    db.query(
      "INSERT INTO app_domain (host, app_id, env, token, created_by, created_at) VALUES (?1, ?2, 'production', ?3, ?4, ?5)",
    ).run(host, input.appId, newToken(), input.createdBy ?? null, now());
  } catch (error) {
    // Two racing adds: the primary key settles it, the check above only
    // named it early.
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/.test(error.message)
    )
      return err("taken");
    throw error;
  }
  return ok(getDomain(db, host)!);
}

export function getDomain(db: Database, host: string): AppDomain | undefined {
  const row = db
    .query<DomainRow, [string]>("SELECT * FROM app_domain WHERE host = ?1")
    .get(normalizeHost(host));
  return row ? toDomain(row) : undefined;
}

/** The row for a host that has been verified — the only kind the proxy serves. */
export function getVerifiedDomain(
  db: Database,
  host: string,
): AppDomain | undefined {
  const found = getDomain(db, host);
  return found?.verifiedAt === null ? undefined : found;
}

/** An app's domains, oldest first. */
export function listDomains(db: Database, appId: string): AppDomain[] {
  return db
    .query<
      DomainRow,
      [string]
    >("SELECT * FROM app_domain WHERE app_id = ?1 ORDER BY created_at, host")
    .all(appId)
    .map(toDomain);
}

/**
 * The domain production's URL is built from: the one verified longest ago,
 * so a second domain added later never moves links that already work.
 */
export function primaryDomain(
  db: Database,
  appId: string,
): AppDomain | undefined {
  const row = db
    .query<
      DomainRow,
      [string]
    >("SELECT * FROM app_domain WHERE app_id = ?1 AND verified_at IS NOT NULL ORDER BY verified_at, host LIMIT 1")
    .get(appId);
  return row ? toDomain(row) : undefined;
}

/** `primaryDomain` for many apps in one read: app id to host, apps with none left out. */
export function primaryHosts(db: Database, appIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (appIds.length === 0) return out;
  const marks = appIds.map(() => "?").join(",");
  const rows = db
    .query<{ app_id: string; host: string }, string[]>(
      `SELECT app_id, host FROM app_domain WHERE app_id IN (${marks}) AND verified_at IS NOT NULL ORDER BY verified_at, host`,
    )
    .all(...appIds);
  for (const r of rows) if (!out.has(r.app_id)) out.set(r.app_id, r.host);
  return out;
}

export function removeDomain(db: Database, host: string): boolean {
  return (
    db.query("DELETE FROM app_domain WHERE host = ?1").run(normalizeHost(host))
      .changes > 0
  );
}

/**
 * What a check found. Verification is a proof of control at one moment,
 * like a certificate's: once given it stays, so a TXT record tidied away
 * later — or a resolver that would not answer today — never takes a live
 * site down. Removing the domain is the one way to unserve it.
 */
export function recordCheck(
  db: Database,
  host: string,
  check: { verified: boolean; said: string },
): AppDomain | undefined {
  const at = now();
  db.query(
    `UPDATE app_domain
       SET checked_at = ?2,
           said = ?3,
           verified_at = CASE WHEN ?4 = 1 AND verified_at IS NULL THEN ?2 ELSE verified_at END
     WHERE host = ?1`,
  ).run(normalizeHost(host), at, check.said, check.verified ? 1 : 0);
  return getDomain(db, host);
}
