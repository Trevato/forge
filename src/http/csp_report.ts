/**
 * POST /csp-report: where a browser says what the Content-Security-Policy
 * blocked (#10759), so a broken or hostile page is seen, not guessed.
 *
 * Both shapes a browser sends are read: the old `report-uri` body
 * (`application/csp-report`, `{"csp-report": {...}}`) and the Reporting API's
 * (`application/reports+json`, an array of `{type: "csp-violation", body}`).
 * At most 8 KB, a known content type, a known shape; anything else is a 4xx
 * and stores nothing. Only three things are kept: the directive, the blocked
 * host (never a path or query string) and the page's path, as one count per
 * UTC day. Rows a day are bounded (`DAY_ROWS`, the rest fold into one), and
 * days past `KEEP_DAYS` are dropped as new ones arrive. Anonymous callers are
 * limited per client and per forge like the page-view beacon. Always 204.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import type { Ctx } from "./context.ts";
import { readBounded } from "./limits.ts";
import { clientBucket } from "./peer.ts";

export const CSP_REPORT_PATH = "/csp-report";
export const CSP_REPORT_MAX = 8 * 1024;
/** The Reporting API endpoint name a policy's `report-to` names. */
export const CSP_REPORT_GROUP = "csp";
/** What a page's policy appends: both the old and the new way to report. */
export const CSP_REPORT_DIRECTIVES = `report-uri ${CSP_REPORT_PATH}; report-to ${CSP_REPORT_GROUP}`;
/** The `Reporting-Endpoints` header naming that group. */
export const CSP_REPORTING_ENDPOINTS = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;

const TYPES = new Set(["application/csp-report", "application/reports+json", "application/json"]);
const DIRECTIVE = /^[a-z][a-z-]{0,39}$/;
const KEYWORD = /^[a-z][a-z0-9-]{0,19}$/;
const PATH_MAX = 200;
const DAY_ROWS = 500;
const KEEP_DAYS = 30;
const OVERFLOW = "(more)";
const PER_CLIENT = 30;
const PER_FORGE = 600;

export interface Violation {
  readonly directive: string;
  readonly blocked: string;
  readonly path: string;
}

const limiter = (perMinute: number) => new RateLimiter({ perMinute, adminPerMinute: perMinute, enabled: true });
const limits = new WeakMap<App, { client: RateLimiter; forge: RateLimiter }>();

const answer = (status: number, headers?: Record<string, string>): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** `script-src-elem 'self'` → `script-src-elem`; anything not a directive name → undefined. */
function directiveOf(raw: string | undefined): string | undefined {
  const name = raw?.trim().split(/\s+/)[0]?.toLowerCase();
  return name !== undefined && DIRECTIVE.test(name) ? name : undefined;
}

/** A URL's host (an http or ws scheme), its scheme otherwise (`data`), or a keyword (`inline`, `eval`). */
function blockedOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === "") return "none";
  if (KEYWORD.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (/^(https?|wss?):$/.test(url.protocol)) return url.host.slice(0, 253) || undefined;
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    return KEYWORD.test(scheme) ? scheme : undefined;
  } catch {
    return undefined;
  }
}

function pathOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return new URL(raw).pathname.slice(0, PATH_MAX);
  } catch {
    return undefined;
  }
}

function one(directive: unknown, blocked: unknown, page: unknown): Violation | undefined {
  const d = directiveOf(text(directive));
  const b = blockedOf(text(blocked));
  const p = pathOf(text(page));
  return d === undefined || b === undefined || p === undefined ? undefined : { directive: d, blocked: b, path: p };
}

/** The violations a body names, or "malformed" when it is not one of the two shapes. */
export function parseCspReport(body: string): Violation[] | "malformed" {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return "malformed";
  }
  if (Array.isArray(data)) {
    if (data.length === 0 || data.length > 20) return "malformed";
    const out: Violation[] = [];
    for (const r of data as unknown[]) {
      if (typeof r !== "object" || r === null) return "malformed";
      const { type, body: b } = r as { type?: unknown; body?: unknown };
      if (type !== "csp-violation") continue;
      if (typeof b !== "object" || b === null) return "malformed";
      const v = b as Record<string, unknown>;
      const got = one(v.effectiveDirective ?? v.violatedDirective, v.blockedURL, v.documentURL);
      if (got === undefined) return "malformed";
      out.push(got);
    }
    return out.length === 0 ? "malformed" : out;
  }
  if (typeof data !== "object" || data === null) return "malformed";
  const r = (data as Record<string, unknown>)["csp-report"];
  if (typeof r !== "object" || r === null) return "malformed";
  const v = r as Record<string, unknown>;
  const got = one(v["effective-directive"] ?? v["violated-directive"], v["blocked-uri"], v["document-uri"]);
  return got === undefined ? "malformed" : [got];
}

/** Count one violation on its UTC day; past `DAY_ROWS` distinct rows a day, the rest share one. */
export function recordViolation(db: Database, v: Violation, now: Date = new Date()): void {
  const day = now.toISOString().slice(0, 10);
  const bump = db.query<unknown, [string, string, string, string]>(
    "UPDATE csp_violation SET n = n + 1 WHERE day = ?1 AND directive = ?2 AND blocked = ?3 AND path = ?4",
  );
  if (bump.run(day, v.directive, v.blocked, v.path).changes > 0) return;
  const rows = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM csp_violation WHERE day = ?1").get(day)?.n ?? 0;
  const key = rows < DAY_ROWS ? v : { directive: v.directive, blocked: OVERFLOW, path: "" };
  db.query(
    `INSERT INTO csp_violation (day, directive, blocked, path, n) VALUES (?1, ?2, ?3, ?4, 1)
      ON CONFLICT (day, directive, blocked, path) DO UPDATE SET n = n + 1`,
  ).run(day, key.directive, key.blocked, key.path);
  if (rows === 0) {
    const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    db.query("DELETE FROM csp_violation WHERE day < ?1").run(cutoff);
  }
}

/** Violations over the last `days` UTC days (today included), per directive, most first. */
export function violationsByDirective(db: Database, days = 7, now: Date = new Date()): { directive: string; n: number }[] {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return db
    .query<{ directive: string; n: number }, [string]>(
      "SELECT directive, SUM(n) AS n FROM csp_violation WHERE day >= ?1 GROUP BY directive ORDER BY n DESC, directive",
    )
    .all(since);
}

export async function cspReportSubmit(ctx: Ctx): Promise<Response> {
  const { request, app } = ctx;
  const origin = request.headers.get("origin");
  // A report carries no Origin or this forge's own; any other site's is not ours to count.
  if (origin !== null && origin !== "null" && origin !== ctx.url.origin) return answer(403);
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!TYPES.has(type)) return answer(415);

  let pair = limits.get(app);
  if (pair === undefined) {
    pair = { client: limiter(PER_CLIENT), forge: limiter(PER_FORGE) };
    limits.set(app, pair);
  }
  for (const verdict of [pair.client.take(clientBucket(request), "ro"), pair.forge.take("forge", "ro")]) {
    if (!verdict.allowed) return answer(429, { "retry-after": String(Math.max(1, verdict.retryAfter)) });
  }

  const bytes = await readBounded(request, CSP_REPORT_MAX);
  if (bytes === "too_large") return answer(413);
  const found = parseCspReport(new TextDecoder().decode(bytes));
  if (found === "malformed") return answer(400);
  for (const v of found) recordViolation(app.db, v);
  return answer(204);
}
