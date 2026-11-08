/**
 * What outside callers tried: one compact line per request that is not a
 * static asset, kept under `<data>/access/` as one file a day.
 *
 * A line is JSON, built only from parts that are safe to keep: the time, the
 * host, the method, the path without its query string (and with any
 * secret-looking segment blanked), the status, the time to headers (a streamed body is not counted), the first 200
 * characters of the user agent, whether the caller presented a credential
 * (never which), and a hash of the client address keyed with the data
 * directory's secret and the day — so one caller is one hash for a day and
 * no hash can be walked back to an address or followed across days. Headers
 * other than the user agent, cookies, bodies and queries are never read.
 *
 * Files older than 14 days go, and the directory is capped in total, oldest
 * first; one day's file sheds its older half at its own cap, so it never stops. Nothing here is served
 * by any route; the owner reads it through `readAccess` (a settings page and
 * the `access` MCP tool).
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  closeSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { loadKey } from "../kernel/secret.ts";

export const KEEP_DAYS = 14;
export const DAY_BYTES = 16 * 1024 * 1024;
export const TOTAL_BYTES = 128 * 1024 * 1024;
/** The log's last line older than this is an alarm. */
export const SILENT_AFTER_S = 300;
const UA_MAX = 200;
const PATH_MAX = 200;
const HOST_MAX = 100;
const READ_MAX = 500;
/** The most one read looks at, newest first: it never stalls the loop for long. */
const READ_BYTES = 4 * 1024 * 1024;
const DAY_MS = 86_400_000;

/** Paths a caller can reach without signing in, for the owner's view. */
export const PUBLIC_PREFIXES = [
  "/issues",
  "/api/",
  "/mcp",
  "/.well-known/",
  "/llms.txt",
  "/signin",
  "/signup",
] as const;

export interface AccessLine {
  /** ISO time the request finished. */
  readonly t: string;
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
  readonly ua: string;
  /** Whether a session cookie or bearer token came with it. */
  readonly auth: boolean;
  /** Keyed daily hash of the client address. */
  readonly who: string;
}

const STATIC = /\.(?:css|js|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf)$/i;

/** A request the log leaves out: assets, and the platform's own health probe. */
export function isQuiet(path: string): boolean {
  return (
    path.startsWith("/assets/") || path === "/healthz" || STATIC.test(path)
  );
}

/** Control characters and DEL removed, then cut: nothing here breaks a line. */
const clean = (text: string, max: number): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);

/**
 * A path as it may be kept: no query, and a segment that could be a secret
 * (a long run of token characters, or a forge token's own prefix) blanked.
 */
export function keptPath(pathname: string): string {
  const segments = pathname.split("/").map((s) => {
    let seg = s;
    try {
      seg = decodeURIComponent(s);
    } catch {
      // keep the raw text; it is judged the same way
    }
    return /^[A-Za-z0-9_~.+=-]{24,}$/.test(seg) || /^(?:frg|forge|fgt)_/i.test(seg)
      ? ":redacted"
      : s;
  });
  return clean(segments.join("/"), PATH_MAX);
}

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);
const fileOf = (dir: string, day: string): string =>
  join(dir, `access-${day}.log`);
export const accessDir = (dataDir: string): string => join(dataDir, "access");

/** The client, as one hash for one day. */
export function clientHash(dataDir: string, address: string, at: Date): string {
  return createHmac("sha256", loadKey(dataDir))
    .update(`access:${dayOf(at)}:${address}`)
    .digest("hex")
    .slice(0, 16);
}

export interface Seen {
  readonly request: Request;
  readonly status: number;
  readonly ms: number;
  readonly client: string;
}

/** The line for a request, or undefined when it is not logged. */
export function lineFor(
  dataDir: string,
  seen: Seen,
  at: Date,
): AccessLine | undefined {
  let url: URL;
  try {
    url = new URL(seen.request.url);
  } catch {
    return undefined;
  }
  if (isQuiet(url.pathname)) return undefined;
  const h = seen.request.headers;
  return {
    t: at.toISOString(),
    host: clean((h.get("host") ?? url.host).toLowerCase(), HOST_MAX),
    method: clean(seen.request.method, 16),
    path: keptPath(url.pathname),
    status: seen.status,
    ms: Math.round(seen.ms),
    ua: clean(h.get("user-agent") ?? "", UA_MAX),
    auth: /(?:^|;\s*)forge_session=/.test(h.get("cookie") ?? "") ||
      (h.get("authorization") ?? "") !== "",
    who: clientHash(dataDir, seen.client, at),
  };
}

let pruned = "";

/** Drop files past their days, then the oldest until the directory fits. */
export function prune(dataDir: string, at: Date, cap: number = TOTAL_BYTES): void {
  const dir = accessDir(dataDir);
  const oldest = dayOf(new Date(at.getTime() - (KEEP_DAYS - 1) * DAY_MS));
  const files = readdirSync(dir)
    .filter((f) => /^access-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort();
  const kept: string[] = [];
  for (const f of files) {
    if (f.slice(7, 17) < oldest) unlinkSync(join(dir, f));
    else kept.push(f);
  }
  let total = kept.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  for (const f of kept) {
    if (total <= cap || f === kept[kept.length - 1]) break;
    total -= statSync(join(dir, f)).size;
    unlinkSync(join(dir, f));
  }
}

/**
 * Keep the newest half of a file, from a whole line: written beside it and
 * renamed over it, so a crash never leaves an empty day. A line another pod
 * appends to the old file between the read and the rename can still be lost.
 * Never throws.
 */
function shedOlder(file: string): void {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, tailOf(file, DAY_BYTES / 2).join("\n"), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // appending still works on the long file
  }
}

/** When the oldest line that has not reached a file was recorded (ms), if any. */
let unwritten: number | undefined;

/**
 * Seconds the oldest recorded line has waited without landing on disk, or
 * undefined when nothing waits. An idle forge has nothing waiting: this
 * measures a writer that is failing, never a site without traffic.
 */
export function unwrittenFor(now: number = Date.now()): number | undefined {
  return unwritten === undefined
    ? undefined
    : Math.max(0, Math.round((now - unwritten) / 1000));
}

/**
 * Lines waiting for the next flush, by the day's file they belong to, with
 * the data directory that owns the file: a hosted child's lines wait beside
 * the parent's and never go into its directory.
 */
const pending = new Map<string, { dataDir: string; lines: string[] }>();
let timer: ReturnType<typeof setTimeout> | undefined;
const FLUSH_MS = 1000;
const FLUSH_LINES = 200;

/** Write everything that waits, one append per file. Never throws. */
export function flushAccess(at: Date = new Date()): void {
  clearTimeout(timer);
  timer = undefined;
  const batches = [...pending];
  pending.clear();
  let failed = false;
  for (const [file, { dataDir, lines }] of batches) {
    try {
      const dir = accessDir(dataDir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const day = dayOf(at);
      if (pruned !== `${dir}:${day}`) {
        pruned = `${dir}:${day}`;
        prune(dataDir, at);
      }
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // no file yet
      }
      // A full day's file sheds its older half: the trail never goes silent.
      if (size >= DAY_BYTES) shedOlder(file);
      appendFileSync(file, lines.join(""), { mode: 0o600 });
    } catch {
      // the log is a convenience; the request is the work
      failed = true;
    }
  }
  // The mark clears only when every line landed and none wait.
  if (!failed && pending.size === 0) unwritten = undefined;
}

/**
 * Keep a request: a line in memory now, on disk within a second or 200 lines,
 * so a request pays for a string and not for a write. Never throws.
 */
export function recordAccess(
  dataDir: string,
  seen: Seen,
  at: Date = new Date(),
): void {
  try {
    const line = lineFor(dataDir, seen, at);
    if (line === undefined) return;
    unwritten ??= at.getTime();
    const file = fileOf(accessDir(dataDir), dayOf(at));
    const queued = pending.get(file) ?? { dataDir, lines: [] };
    queued.lines.push(`${JSON.stringify(line)}\n`);
    pending.set(file, queued);
    let count = 0;
    for (const q of pending.values()) count += q.lines.length;
    if (count >= FLUSH_LINES) flushAccess(at);
    else if (timer === undefined) {
      timer = setTimeout(() => flushAccess(), FLUSH_MS);
      timer.unref();
    }
  } catch {
    // the log is a convenience; the request is the work
  }
}

/** The last `max` bytes of a file as whole lines. */
function tailOf(file: string, max: number): string[] {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    // A cut file begins part-way through a line: drop that line.
    if (length < size) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

export interface AccessQuery {
  /** ISO time to read from; the last day when absent or unreadable. */
  readonly since?: string;
  /** Case-insensitive part of the user agent. */
  readonly ua?: string;
  /** Start of the path. */
  readonly path?: string;
}

/** A browser says so in its user agent; an agent, a script or a probe does not. */
export const isBrowser = (ua: string): boolean => ua.includes("Mozilla/");

const isPublic = (path: string): boolean =>
  PUBLIC_PREFIXES.some((p) => path.startsWith(p));

/**
 * The last day's (or `since`'s) non-browser requests to public paths, newest
 * first, at most 500.
 */
export function readAccess(
  dataDir: string,
  query: AccessQuery,
  now: Date = new Date(),
): AccessLine[] {
  flushAccess(now);
  const floor = now.getTime() - KEEP_DAYS * DAY_MS;
  const parsed = query.since === undefined ? NaN : Date.parse(query.since);
  const from = Math.max(
    Number.isNaN(parsed) ? now.getTime() - DAY_MS : parsed,
    floor,
  );
  const ua = query.ua?.toLowerCase();
  const dir = accessDir(dataDir);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => /^access-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .filter((f) => f.slice(7, 17) >= dayOf(new Date(from)))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  let budget = READ_BYTES;
  const out: AccessLine[] = [];
  for (const f of files) {
    if (budget <= 0) break;
    const lines = tailOf(join(dir, f), budget).reverse();
    budget -= lines.reduce((n, l) => n + l.length + 1, 0);
    for (const raw of lines) {
      if (raw === "") continue;
      let line: AccessLine;
      try {
        line = JSON.parse(raw) as AccessLine;
      } catch {
        continue;
      }
      if (Date.parse(line.t) < from) continue;
      if (isBrowser(line.ua) || !isPublic(line.path)) continue;
      if (ua !== undefined && !line.ua.toLowerCase().includes(ua)) continue;
      if (query.path !== undefined && !line.path.startsWith(query.path))
        continue;
      out.push(line);
      if (out.length >= READ_MAX) return out;
    }
  }
  return out;
}
