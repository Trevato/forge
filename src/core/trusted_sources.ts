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
import { closesFromBody } from "./pulls.ts";

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

/** A downstream forge's proposals are trusted under this prefix; no origin account can carry it (`cleanAccount` refuses ":"). */
export const CHILD_PREFIX = "child:";

/** The account a trust row is kept under: an origin's account, or `child:<name>` for a downstream forge's proposals. */
export function cleanTrustAccount(raw: string): string | undefined {
  const text = raw.trim().toLowerCase();
  if (!text.startsWith(CHILD_PREFIX)) return cleanAccount(text);
  const name = text.slice(CHILD_PREFIX.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name) ? text : undefined;
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
  const account = cleanTrustAccount(input.account);
  if (account === undefined) return "bad_account";
  const day = input.until.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "bad_date";
  const end = new Date(`${day}T23:59:59.999Z`);
  // A day that does not exist (02-31) rolls into the next month: refuse it rather than guess.
  if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== day) return "bad_date";
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

/** How long a trust has left, in words: "29 days left", "less than a day left", or "lapsed". */
export function leftWords(until: string, now: Date = new Date()): string {
  const ms = Date.parse(until) - now.getTime();
  if (Number.isNaN(ms) || ms <= 0) return "lapsed";
  const days = Math.floor(ms / DAY_MS);
  if (days < 1) return "less than a day left";
  return `${days} day${days === 1 ? "" : "s"} left`;
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
  input: { pullId: string; host: string; account: string; via: readonly string[]; big?: boolean },
  now: Date = new Date(),
): void {
  db.query(
    `INSERT OR IGNORE INTO pull_source (pull_id, host, account, via, received_at, big)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(
    input.pullId,
    input.host.toLowerCase(),
    input.account.toLowerCase(),
    input.via.join(","),
    now.toISOString(),
    input.big === true ? 1 : 0,
  );
  if (input.big === true) db.query("UPDATE pull_source SET big = 1 WHERE pull_id = ?1").run(input.pullId);
}

/** A fold this many commits long is not landed on a check alone: the crew reviews it first (#9003). */
export const BIG_FOLD_COMMITS = 50;

/** Whether the crew reviews this pull before it lands, trusted or not: a big fold, or the crew's resolution of a conflict. */
export function needsCrewReview(db: Database, pullId: string): boolean {
  const row = db
    .query<{ big: number }, [string]>("SELECT big FROM pull_source WHERE pull_id = ?1")
    .get(pullId);
  return row !== null && row.big === 1;
}

/**
 * The crew's resolution of a source's conflict carries that source: a pull
 * written by an agent whose description closes the conflict issue the source
 * raised. Only an agent's pull is adopted, so a guest writing `Closes #N`
 * gains nothing. Stamped once, reviewed by the crew before it lands. A write,
 * so it is called where a pull is opened or its description edited, never
 * from the predicates that read.
 */
export function adoptResolution(db: Database, pullId: string): PullSource | undefined {
  const pull = db
    .query<{ repo_id: string; body: string; is_agent: number }, [string]>(
      `SELECT i.repo_id, i.body, u.is_agent FROM issue i JOIN user u ON u.id = i.author_id
        WHERE i.id = ?1 AND i.kind = 'pull'`,
    )
    .get(pullId);
  if (pull === null || pull.is_agent !== 1) return undefined;
  for (const number of closesFromBody(pull.body)) {
    const c = db
      .query<{ host: string; account: string; via: string }, [string, number]>(
        `SELECT c.host, c.account, c.via FROM source_conflict c JOIN issue i ON i.id = c.issue_id
          WHERE i.repo_id = ?1 AND i.number = ?2`,
      )
      .get(pull.repo_id, number);
    if (c === null) continue;
    recordPullSource(db, {
      pullId,
      host: c.host,
      account: c.account,
      via: c.via === "" ? [] : c.via.split(","),
      big: true,
    });
    return pullSourceOf(db, pullId);
  }
  return undefined;
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
  if (foldInStopped(db) !== undefined) return false;
  const from = pullSourceOf(db, pullId) ?? proposerOf(db, pullId);
  if (from !== undefined) return isTrusted(db, from.host, from.account, now);
  return localSourceTrusted(db, pullId, now);
}

// --- trust for work opened on this same forge --------------------------------

const selfHosts = new WeakMap<Database, string>();

/** Tell the trust layer which name this forge goes by in trust lists (called once, where the app is made). */
export function setOwnHost(db: Database, host: string): void {
  selfHosts.set(db, host.toLowerCase());
}

/**
 * A pull opened here, from the opener's own fork on this forge (not a
 * mirror's), by an account trusted for this forge's own host. Trust is read
 * now, so a lapse or a removal makes the next question answer no.
 */
function localSourceTrusted(db: Database, pullId: string, now: Date): boolean {
  const self = selfHosts.get(db);
  if (self === undefined) return false;
  const row = db
    .query<{ account: string }, [string]>(
      `SELECT u.username AS account FROM issue i
         JOIN pull p ON p.issue_id = i.id
         JOIN user u ON u.id = i.author_id
         JOIN repo h ON h.id = p.head_repo_id
        WHERE i.id = ?1 AND i.kind = 'pull'
          AND p.head_repo_id <> i.repo_id AND p.origin_head_repo IS NULL
          AND h.owner_id = i.author_id AND h.fork_parent_id = i.repo_id`,
    )
    .get(pullId);
  return row !== null && isTrusted(db, self, row.account, now);
}

/**
 * A downstream forge's proposal (#9451) is a source like any other: the
 * forge is the host of the origin the proposal token was minted for, the
 * account is `child:<name>`, the name a writer here chose when minting the
 * token (the origin is typed by that writer too; only a writer can mint, and
 * a proposal's pull is opened through that token). The prefix keeps it from
 * ever equalling an origin's account. A writer trusts that pair exactly as they trust an origin's account, so it ends by
 * date, the same walls apply and the same stop switch stops it.
 */
function proposerOf(db: Database, pullId: string): { host: string; account: string } | undefined {
  const row = db
    .query<{ child: string; origin: string }, [string]>("SELECT child, origin FROM pull_proposal WHERE issue_id = ?1")
    .get(pullId);
  if (row === null) return undefined;
  const host = cleanHost(row.origin);
  return host === undefined ? undefined : { host, account: `${CHILD_PREFIX}${row.child}` };
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
