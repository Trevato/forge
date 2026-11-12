/**
 * What a repository's cells were refused, said out loud (#10456): one small
 * file per repository under `<data>/egress/`, one row per host and port with
 * when it was first and last refused and how many times — deduplicated, so a
 * retry loop is one row and a count, never a log flood. Counts are kept in
 * memory and reach the file every few seconds, not on each refusal. Only the
 * production cell reports here and reads the allowed file: a preview (any
 * pull branch, a fork's too) neither inherits the owner's yes nor writes to
 * the owner's list. The owner's page, notifications, terminal and the crew's
 * brief read it; Allow adds to a second file, the hosts allowed at once,
 * which the proxy asks on every connection.
 */

import { during } from "../perf/jobs.ts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { hostAllowed } from "./egress.ts";
import { defect } from "../kernel/error.ts";
import { sinceWords } from "../kernel/vitals.ts";

export interface Refusal {
  readonly host: string;
  readonly port: number;
  readonly count: number;
  readonly first: string;
  readonly last: string;
  /** The owner said no: still counted, no longer said. */
  readonly denied: boolean;
  /** A private address or a name that resolves to one: a site admin's yes. */
  readonly private: boolean;
}

/** At most this many hosts are kept per repository; once full, new hosts are dropped, never old ones. */
export const ROWS_MAX = 50;
/** An allowed list read is reused this long ("within seconds"). */
const ALLOWED_TTL_MS = 2_000;
/** Counts live in memory and reach the disk at most this often. */
const FLUSH_MS = 5_000;

function fileFor(dataDir: string, repoId: string, kind: "refused" | "allowed"): string {
  if (!/^[0-9a-z]+$/i.test(repoId))
    defect("apps.bad_egress_path", `refusing to build a path for ${repoId}`);
  return join(dataDir, "egress", `${repoId}.${kind}.json`);
}

function write(file: string, dataDir: string, value: unknown): void {
  mkdirSync(join(dataDir, "egress"), { recursive: true });
  writeFileSync(`${file}.new`, JSON.stringify(value));
  renameSync(`${file}.new`, file);
}

const isRefusal = (r: unknown): r is Refusal =>
  typeof r === "object" &&
  r !== null &&
  typeof (r as Refusal).host === "string" &&
  typeof (r as Refusal).port === "number" &&
  typeof (r as Refusal).count === "number" &&
  typeof (r as Refusal).first === "string" &&
  typeof (r as Refusal).last === "string";

/**
 * The host as a cell named it, cleaned, or undefined: it comes from app code
 * (the CONNECT line) and ends in a page and an agent's brief, so only a
 * hostname or an IP address of at most 253 characters is kept.
 */
export function cleanHost(host: unknown): string | undefined {
  if (typeof host !== "string") return undefined;
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name.length === 0 || name.length > 253) return undefined;
  if (isIP(name) !== 0) return name;
  return /^([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(name) ? name : undefined;
}

// ---- refused, counted in memory ----

interface Book {
  rows: Refusal[];
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}
const books = new Map<string, Book>();

function book(dataDir: string, repoId: string): Book {
  const file = fileFor(dataDir, repoId, "refused");
  let b = books.get(file);
  if (b !== undefined) return b;
  let rows: Refusal[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) rows = parsed.filter(isRefusal).slice(0, ROWS_MAX);
  } catch {
    rows = [];
  }
  b = { rows, dirty: false, timer: undefined };
  books.set(file, b);
  return b;
}

function flushBook(dataDir: string, repoId: string): void {
  const b = book(dataDir, repoId);
  if (b.timer !== undefined) clearTimeout(b.timer);
  b.timer = undefined;
  if (!b.dirty) return;
  b.dirty = false;
  try {
    write(fileFor(dataDir, repoId, "refused"), dataDir, b.rows);
  } catch {
    b.dirty = true;
  }
}

/** Write what is counted to disk now (a stop, a test); otherwise it follows within seconds. */
export function flushRefused(dataDir: string, repoId: string): void {
  flushBook(dataDir, repoId);
}

function save(dataDir: string, repoId: string, now: boolean): void {
  const b = book(dataDir, repoId);
  b.dirty = true;
  if (now) return flushBook(dataDir, repoId);
  if (b.timer !== undefined) return;
  b.timer = setTimeout(() => during("egress-refused-flush", () => flushBook(dataDir, repoId)), FLUSH_MS);
  b.timer.unref?.();
}

/** Every host refused for `repoId`, most recent first (ignored ones too). */
export function refusedHosts(dataDir: string, repoId: string): Refusal[] {
  return [...book(dataDir, repoId).rows];
}

/** What is still said: the refusals the owner has neither ignored nor allowed. */
export function blockedHosts(dataDir: string, repoId: string, allowed = allowedHosts(dataDir, repoId)): Refusal[] {
  return refusedHosts(dataDir, repoId).filter((r) => !r.denied && !hostAllowed(allowed, r.host, r.port));
}

/**
 * Count one refused connection. True the first time this host and port is
 * seen; a host that is not a hostname or address, or one that would be the
 * fifty-first, is dropped (a cell cannot push real rows out by rotating names).
 */
export function noteRefused(
  dataDir: string,
  repoId: string,
  rawHost: string,
  port: number,
  isPrivate: boolean,
  now = new Date().toISOString(),
): boolean {
  const host = cleanHost(rawHost);
  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const b = book(dataDir, repoId);
  const prior = b.rows.find((r) => r.host === host && r.port === port);
  if (prior === undefined && b.rows.length >= ROWS_MAX) return false;
  const row: Refusal = {
    host,
    port,
    count: (prior?.count ?? 0) + 1,
    first: prior?.first ?? now,
    last: now,
    denied: prior?.denied ?? false,
    private: isPrivate,
  };
  b.rows = [row, ...b.rows.filter((r) => r !== prior)];
  save(dataDir, repoId, false);
  return prior === undefined;
}

/** Ignore one row (kept and counted, no longer said). */
export function ignoreRefused(dataDir: string, repoId: string, host: string, port: number): boolean {
  const b = book(dataDir, repoId);
  const prior = b.rows.find((r) => r.host === host && r.port === port);
  if (prior === undefined) return false;
  b.rows = b.rows.map((r) => (r === prior ? { ...r, denied: true } : r));
  save(dataDir, repoId, true);
  return true;
}

// ---- allowed at once ----

const cache = new Map<string, { at: number; hosts: string[] }>();

/** The `forge.json` `egress` entries an owner allowed through the switch. */
export function allowedHosts(dataDir: string, repoId: string, now = Date.now()): string[] {
  const file = fileFor(dataDir, repoId, "allowed");
  const hit = cache.get(file);
  if (hit !== undefined && now - hit.at < ALLOWED_TTL_MS) return hit.hosts;
  let hosts: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) hosts = parsed.filter((h): h is string => typeof h === "string");
  } catch {
    hosts = [];
  }
  cache.set(file, { at: now, hosts });
  return hosts;
}

/** Allow an entry now: the next connection passes, no redeploy. */
export function allowNow(dataDir: string, repoId: string, entry: string): void {
  const file = fileFor(dataDir, repoId, "allowed");
  const hosts = [...new Set([...allowedHosts(dataDir, repoId, 0), entry])];
  write(file, dataDir, hosts);
  cache.delete(file);
}

/**
 * What a cell of `env` is given to ask and tell: production alone. A preview
 * runs a pull's code (a fork's too), so it neither inherits the owner's yes
 * nor writes into the owner's list. `first` is told of a host's first refusal.
 */
export function cellHooks(
  dataDir: string,
  repoId: string,
  env: string,
  first: (host: string, port: number) => void,
): {
  allowed?: () => readonly string[];
  onRefused?: (host: string, port: number, isPrivate: boolean) => void;
} {
  if (env !== "production") return {};
  return {
    allowed: () => allowedHosts(dataDir, repoId),
    onRefused: (host, port, isPrivate) => {
      if (noteRefused(dataDir, repoId, host, port, isPrivate)) first(host, port);
    },
  };
}

// ---- words ----

/** The `forge.json` entry for a host and port (a port is named unless 80 or 443). */
export const entryFor = (host: string, port: number): string =>
  port === 80 || port === 443 ? host : `${host}:${port}`;

/** "Blocked: huggingface.co (14 tries, last 2 min ago)" */
export function refusalLine(r: Refusal, now = Date.now()): string {
  const name = r.port === 80 || r.port === 443 ? r.host : `${r.host}:${r.port}`;
  return `Blocked: ${name} (${r.count} ${r.count === 1 ? "try" : "tries"}, last ${sinceWords(r.last, now)})`;
}
