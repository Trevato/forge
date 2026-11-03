/**
 * Trusted sources (#8937): an account on a named forge, until a date, set by
 * a person. An account name means nothing without its forge — the same name
 * elsewhere is a stranger — so a source is always the pair. Trust ends by
 * itself: past `until` a source is no longer listed as active and its work
 * waits for review like anyone's. Pure data, no authz, no events;
 * `actions/trusted_sources.ts` decides who may change it and audits it.
 */
import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";

export interface TrustedSource {
  readonly id: string;
  readonly host: string;
  readonly account: string;
  readonly until: string;
  readonly setBy: string;
  readonly createdAt: string;
  readonly warnedAt: string | null;
}

interface Row {
  id: string;
  host: string;
  account: string;
  until: string;
  set_by: string;
  created_at: string;
  warned_at: string | null;
}

const toSource = (r: Row): TrustedSource => ({
  id: r.id,
  host: r.host,
  account: r.account,
  until: r.until,
  setBy: r.set_by,
  createdAt: r.created_at,
  warnedAt: r.warned_at,
});

/** Days before expiry that the note is sent. */
export const WARN_DAYS = 3;
const DAY_MS = 86_400_000;

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;
const ACCOUNT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A forge's name as a source is kept: lowercase host, no scheme, no path. */
export function cleanHost(raw: string): string | undefined {
  const text = raw.trim().toLowerCase();
  const host = URL.parse(text)?.host || text.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  return HOST.test(host) ? host : undefined;
}

export function cleanAccount(raw: string): string | undefined {
  const name = raw.trim().replace(/^@/, "").toLowerCase();
  return ACCOUNT.test(name) ? name : undefined;
}

export type TrustError = "bad_host" | "bad_account" | "bad_date" | "in_the_past";

/** Keep (or renew) a source. The end is a calendar date, read as the end of that UTC day. */
export function trustSource(
  db: Database,
  input: { host: string; account: string; until: string; setBy: string },
  now: Date = new Date(),
): TrustedSource | TrustError {
  const host = cleanHost(input.host);
  if (host === undefined) return "bad_host";
  const account = cleanAccount(input.account);
  if (account === undefined) return "bad_account";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until)) return "bad_date";
  const end = new Date(`${input.until}T23:59:59.999Z`);
  if (Number.isNaN(end.getTime())) return "bad_date";
  if (end.getTime() <= now.getTime()) return "in_the_past";
  const until = end.toISOString();
  db.query(
    `INSERT INTO trusted_source (id, host, account, until, set_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (host, account)
     DO UPDATE SET until = excluded.until, set_by = excluded.set_by, warned_at = NULL`,
  ).run(id(), host, account, until, input.setBy, now.toISOString());
  return sourceOf(db, host, account)!;
}

export function sourceOf(db: Database, host: string, account: string): TrustedSource | undefined {
  const row = db
    .query<Row, [string, string]>("SELECT * FROM trusted_source WHERE host = ?1 AND account = ?2")
    .get(host.toLowerCase(), account.toLowerCase());
  return row === null ? undefined : toSource(row);
}

export function untrust(db: Database, sourceId: string): TrustedSource | undefined {
  const row = db.query<Row, [string]>("SELECT * FROM trusted_source WHERE id = ?1").get(sourceId);
  if (row === null) return undefined;
  db.query("DELETE FROM trusted_source WHERE id = ?1").run(sourceId);
  return toSource(row);
}

/** Every entry, expired ones included (the page shows them as lapsed), soonest end first. */
export function listTrusted(db: Database): TrustedSource[] {
  return db.query<Row, []>("SELECT * FROM trusted_source ORDER BY until, host, account").all().map(toSource);
}

/** Whether the account on that forge is trusted at `now`. */
export function isTrusted(db: Database, host: string, account: string, now: Date = new Date()): boolean {
  const source = sourceOf(db, host, account);
  return source !== undefined && source.until > now.toISOString();
}

/** Entries that end within the warning window and have not been told about yet. */
export function dueWarning(db: Database, now: Date = new Date()): TrustedSource[] {
  const soon = new Date(now.getTime() + WARN_DAYS * DAY_MS).toISOString();
  return db
    .query<Row, [string, string]>(
      "SELECT * FROM trusted_source WHERE warned_at IS NULL AND until > ?1 AND until <= ?2",
    )
    .all(now.toISOString(), soon)
    .map(toSource);
}

export function markWarned(db: Database, sourceId: string, now: Date = new Date()): void {
  db.query("UPDATE trusted_source SET warned_at = ?2 WHERE id = ?1").run(sourceId, now.toISOString());
}

/** Whether the entry ends within the warning window (or already has). */
export const endsSoon = (s: TrustedSource, now: Date = new Date()): boolean =>
  Date.parse(s.until) - now.getTime() <= WARN_DAYS * DAY_MS;

// --- the kill switch -------------------------------------------------------

export function foldInStopped(db: Database): { by: string; at: string } | undefined {
  const row = db.query<{ by: string; at: string }, []>("SELECT by, at FROM fold_in_stop WHERE id = 1").get();
  return row ?? undefined;
}

export function stopFoldIn(db: Database, by: string, now: Date = new Date()): void {
  db.query("INSERT OR REPLACE INTO fold_in_stop (id, by, at) VALUES (1, ?1, ?2)").run(by, now.toISOString());
}

export function resumeFoldIn(db: Database): void {
  db.query("DELETE FROM fold_in_stop WHERE id = 1").run();
}

// --- where a pull came from ------------------------------------------------

export interface PullSource {
  readonly pullId: string;
  readonly host: string;
  readonly account: string;
  /** Forges the work passed through before it reached this one, oldest first. */
  readonly via: readonly string[];
}

/** Where a pull came from; the first word stands, a later call never rewrites it. */
export function recordPullSource(
  db: Database,
  input: { pullId: string; host: string; account: string; via: readonly string[] },
  now: Date = new Date(),
): void {
  db.query(
    `INSERT OR IGNORE INTO pull_source (pull_id, host, account, via, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).run(input.pullId, input.host.toLowerCase(), input.account.toLowerCase(), input.via.join(","), now.toISOString());
}

export function pullSourceOf(db: Database, pullId: string): PullSource | undefined {
  const row = db
    .query<{ host: string; account: string; via: string }, [string]>(
      "SELECT host, account, via FROM pull_source WHERE pull_id = ?1",
    )
    .get(pullId);
  return row === null
    ? undefined
    : { pullId, host: row.host, account: row.account, via: row.via === "" ? [] : row.via.split(",") };
}

/** `account@host` of the pulls (by number, in one repository) that came from another forge. */
export function sourcesOfPulls(db: Database, repoId: string, numbers: readonly number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (numbers.length === 0) return out;
  const rows = db
    .query<{ number: number; account: string; host: string }, (string | number)[]>(
      `SELECT i.number, s.account, s.host FROM issue i JOIN pull_source s ON s.pull_id = i.id
        WHERE i.repo_id = ?1 AND i.number IN (${numbers.map((_, n) => `?${n + 2}`).join(",")})`,
    )
    .all(repoId, ...numbers);
  for (const r of rows) out.set(r.number, `${r.account}@${r.host}`);
  return out;
}

/** Pull ids that came from one source, newest first. */
export function pullIdsFrom(db: Database, host: string, account: string): string[] {
  return db
    .query<{ pull_id: string }, [string, string]>(
      "SELECT pull_id FROM pull_source WHERE host = ?1 AND account = ?2 ORDER BY received_at DESC",
    )
    .all(host.toLowerCase(), account.toLowerCase())
    .map((r) => r.pull_id);
}

// --- a landing says where it came from -------------------------------------

/**
 * Whether a pull's source is trusted right now and folding in is not
 * stopped: the one question the crew's landing path asks. Trust skips the
 * person's review and nothing else.
 */
export function foldsIn(db: Database, pullId: string, now: Date = new Date()): boolean {
  const from = pullSourceOf(db, pullId);
  return from !== undefined && foldInStopped(db) === undefined && isTrusted(db, from.host, from.account, now);
}

/**
 * The trailers a landing from another forge carries. `Landed-via` lists
 * every forge the work passed through, this one last: a forge that finds
 * itself in the list will not take the work again (`takeable`).
 */
export function sourceTrailers(from: PullSource, selfHost: string): string {
  const via = [...from.via, from.host, selfHost.toLowerCase()].filter((h, i, all) => all.indexOf(h) === i);
  return `Landed-from: ${from.account}@${from.host}\nLanded-via: ${via.join(",")}`;
}

/** `Landed-via` read back from a commit message; empty when it has none. */
export function viaOf(message: string): string[] {
  const line = /^Landed-via: ([a-z0-9.,:-]{1,500})$/m.exec(message);
  return line === null ? [] : line[1]!.split(",").filter((h) => HOST.test(h));
}

/** Work that already passed through this forge is not taken in again: that is how a ring of forges stops. */
export const takeable = (via: readonly string[], selfHost: string): boolean => !via.includes(selfHost.toLowerCase());

/** This forge's own name as other forges' trust lists spell it. */
export function ownHost(config: { url?: string | undefined; host?: string | undefined }): string {
  return (config.url === undefined ? undefined : URL.parse(config.url)?.host.toLowerCase()) ?? (config.host ?? "localhost").toLowerCase();
}

/**
 * Who an upstream's address names: the forge, and the account that owns the
 * repository (`https://host/account/name.git`). This is the owner of the
 * followed repository, not a verified commit author: trust here means "work
 * from the repository this account owns", and commits in it keep whatever
 * author they carry.
 */
export function sourceOfUrl(url: string): { host: string; account: string } | undefined {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return undefined;
  const host = cleanHost(parsed.host);
  const account = cleanAccount(parsed.pathname.split("/").filter((s) => s !== "")[0] ?? "");
  return host === undefined || account === undefined ? undefined : { host, account };
}
