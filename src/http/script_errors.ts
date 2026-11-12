/**
 * POST /_script-error: where the beacon says a page threw (#11447), so a real
 * visit names what breaks. Same-origin only, opted-out visitors stored
 * nothing, at most 2 KB, an exact shape `{page, src, line, msg}` or a 4xx:
 * `page` a served route's path, `src` empty or a path (no origin, no query),
 * `line` a small integer, `msg` cut to its first line and 120 characters.
 * One count per page + script + line + message per UTC hour; rows a day are
 * bounded (`DAY_ROWS`, the rest fold into one), days past `KEEP_DAYS` are
 * dropped as new ones arrive, anonymous callers are rate limited. Always an
 * empty answer; nothing is read back except by the admin's security page.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import { optedOut } from "../web/measure.ts";
import type { Ctx } from "./context.ts";
import { readBounded } from "./limits.ts";
import { clientBucket } from "./peer.ts";
import type { RouteOf } from "./measure.ts";
import { windowStart } from "./csp_report.ts";

export const SCRIPT_ERROR_PATH = "/_script-error";
export const SCRIPT_ERROR_MAX = 2 * 1024;
export const MESSAGE_MAX = 120;
const PATH_MAX = 200;
const DAY_ROWS = 500;
const KEEP_DAYS = 30;
const OVERFLOW = "(more)";
const PER_CLIENT = 30;
const PER_FORGE = 600;

export interface ScriptError {
  readonly page: string;
  readonly src: string;
  readonly line: number;
  readonly msg: string;
}

const limiter = (perMinute: number) => new RateLimiter({ perMinute, adminPerMinute: perMinute, enabled: true });
const limits = new WeakMap<App, { client: RateLimiter; forge: RateLimiter }>();
const answer = (status: number, headers?: Record<string, string>): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });

const isPath = (v: unknown): v is string =>
  typeof v === "string" && v.length <= PATH_MAX && /^\/[^?#\s\\]*$/.test(v) && !v.startsWith("//");

/** The error a body names, or "malformed". */
export function parseScriptError(body: string): ScriptError | "malformed" {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return "malformed";
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return "malformed";
  const v = data as Record<string, unknown>;
  if (Object.keys(v).length !== 4) return "malformed";
  const { page, src, line, msg } = v;
  if (!isPath(page)) return "malformed";
  if (src !== "" && !isPath(src)) return "malformed";
  if (typeof line !== "number" || !Number.isInteger(line) || line < 0 || line > 10_000_000) return "malformed";
  if (typeof msg !== "string") return "malformed";
  // eslint-disable-next-line no-control-regex
  const first = (msg.split(/[\r\n]/)[0] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MESSAGE_MAX);
  return first === "" ? "malformed" : { page, src: src as string, line, msg: first };
}

const hourOf = (ms: number): string => new Date(ms).toISOString().slice(0, 13);

/** Count one error in its UTC hour; past `DAY_ROWS` distinct rows a UTC day, the rest share one. */
export function recordScriptError(db: Database, e: ScriptError, now: Date = new Date()): void {
  const seen = now.getTime();
  const hour = hourOf(seen);
  const day = hour.slice(0, 10);
  const bump = db.query<unknown, [string, string, string, number, string, number]>(
    "UPDATE script_error SET n = n + 1, seen = ?6 WHERE day = ?1 AND page = ?2 AND src = ?3 AND line = ?4 AND msg = ?5",
  );
  if (bump.run(hour, e.page, e.src, e.line, e.msg, seen).changes > 0) return;
  const rows =
    db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM script_error WHERE day >= ?1 AND day <= ?2").get(`${day}T00`, `${day}T23`)?.n ?? 0;
  const key = rows < DAY_ROWS ? e : { page: "", src: "", line: 0, msg: OVERFLOW };
  db.query(
    `INSERT INTO script_error (day, page, src, line, msg, n, seen) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
      ON CONFLICT (day, page, src, line, msg) DO UPDATE SET n = n + 1, seen = ?6`,
  ).run(hour, key.page, key.src, key.line, key.msg, seen);
  if (rows === 0) {
    const cutoff = new Date(seen - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    db.query("DELETE FROM script_error WHERE day < ?1").run(cutoff);
  }
}

export interface ScriptErrorCount {
  readonly page: string;
  /** The script's path and line, `/a.js:3`; the page's own path when the error was inline. */
  readonly where: string;
  readonly message: string;
  readonly n: number;
  /** ISO time of the last count. */
  readonly last: string;
}

/** Errors counted in the last `hours` (whole UTC hours, as the CSP counts), most counted first. */
export function scriptErrorCounts(db: Database, hours = 7 * 24, now: Date = new Date(), limit = 20): ScriptErrorCount[] {
  const from = hourOf(windowStart(hours, now).getTime());
  return db
    .query<{ page: string; src: string; line: number; msg: string; n: number; seen: number }, [string, number]>(
      `SELECT page, src, line, msg, SUM(n) AS n, MAX(seen) AS seen FROM script_error
        WHERE day >= ?1 GROUP BY page, src, line, msg ORDER BY n DESC, seen DESC LIMIT ?2`,
    )
    .all(from, limit)
    .map((r) => ({
      page: r.page,
      where: r.src === "" ? (r.line > 0 ? `inline:${r.line}` : "inline") : `${r.src}:${r.line}`,
      message: r.msg,
      n: r.n,
      last: new Date(r.seen).toISOString(),
    }));
}

export async function scriptErrorSubmit(ctx: Ctx, routeOf: RouteOf): Promise<Response> {
  const { request, app } = ctx;
  if (request.headers.get("origin") !== ctx.url.origin) return answer(403);
  if (optedOut(request)) return answer(204);

  let pair = limits.get(app);
  if (pair === undefined) {
    pair = { client: limiter(PER_CLIENT), forge: limiter(PER_FORGE) };
    limits.set(app, pair);
  }
  for (const verdict of [pair.client.take(clientBucket(request), "ro"), pair.forge.take("forge", "ro")]) {
    if (!verdict.allowed) return answer(429, { "retry-after": String(Math.max(1, verdict.retryAfter)) });
  }

  const bytes = await readBounded(request, SCRIPT_ERROR_MAX);
  if (bytes === "too_large") return answer(413);
  const found = parseScriptError(new TextDecoder().decode(bytes));
  if (found === "malformed" || routeOf(found.page) === undefined) return answer(400);
  recordScriptError(app.db, found);
  return answer(204);
}
