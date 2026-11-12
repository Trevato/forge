/**
 * The page-view beacon's receiver: validate a report, hash the visitor, store
 * the numbers. Plain data in, plain data out. What is stored is the route
 * pattern (never the path, which can name a repository), the five metrics,
 * and a visitor hash; the address and the user agent string are read to make
 * that hash and are never written anywhere.
 *
 * The salt rotates daily and the old salts are deleted, so a hash means "the
 * same browser today" and cannot be joined across days. Rows are kept 90 days.
 *
 * Anyone can post here, so the table is bounded by what is stored, not only
 * by the rate: a day keeps at most DAY_MAX rows and the rest are dropped.
 */

import type { Database } from "bun:sqlite";
import { quietly } from "../core/write_clock.ts";
import { sha256 } from "../kernel/hash.ts";
import { dayOf } from "../perf/day.ts";

/** A report is a few dozen bytes; this is already generous. */
export const REPORT_MAX = 512;
/** Times in milliseconds: ten minutes is longer than any real page view. */
export const TIME_MAX = 600_000;
export const CLS_MAX = 100;
/** The most rows one day keeps; past it a report is dropped (and still answered 204). */
export const DAY_MAX = 20_000;
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export interface Report {
  readonly path: string;
  readonly ttfb: number | null;
  readonly load: number | null;
  readonly lcp: number | null;
  readonly inp: number | null;
  readonly cls: number;
  /** document.referrer, location.search and the host of the link the visitor left by; absent from an older beacon. */
  readonly ref?: string;
  readonly q?: string;
  readonly out?: string;
}

const FIELDS = new Set(["path", "ttfb", "load", "lcp", "inp", "cls", "ref", "q", "out"]);

/** An optional text field: absent is fine, a wrong kind or a long or control-laden one is malformed. */
function optionalText(body: Record<string, unknown>, key: string, max: number): string | undefined | "malformed" {
  const given = body[key];
  if (given === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  if (typeof given !== "string" || given.length > max || /[\u0000-\u001f\u007f]/.test(given)) return "malformed";
  return given;
}

const bounded = (value: unknown, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : undefined;

/** A report from the body's text, or why not. Unknown keys are refused. */
export function parseReport(text: string): Report | "malformed" {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "malformed";
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "malformed";
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !FIELDS.has(key))) return "malformed";
  const { path } = body;
  if (typeof path !== "string" || path.length > 512 || !path.startsWith("/"))
    return "malformed";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "malformed";
  const cls = bounded(body["cls"], CLS_MAX);
  if (cls === undefined) return "malformed";
  const times: Record<string, number | null> = {};
  for (const key of ["ttfb", "load", "lcp", "inp"] as const) {
    const given = body[key];
    if (given === undefined) {
      times[key] = null;
      continue;
    }
    const value = bounded(given, TIME_MAX);
    if (value === undefined) return "malformed";
    // 0 is how the beacon says "not measured".
    times[key] = value === 0 ? null : value;
  }
  const ref = optionalText(body, "ref", 300);
  const q = optionalText(body, "q", 300);
  const out = optionalText(body, "out", 253);
  if (ref === "malformed" || q === "malformed" || out === "malformed") return "malformed";
  return {
    path,
    ttfb: times["ttfb"] ?? null,
    load: times["load"] ?? null,
    lcp: times["lcp"] ?? null,
    inp: times["inp"] ?? null,
    cls,
    ...(ref === undefined ? {} : { ref }),
    ...(q === undefined ? {} : { q }),
    ...(out === undefined ? {} : { out }),
  };
}

/** The visitor asked not to be measured: Do-Not-Track, or the opt-out cookie. */
export function optedOut(request: Request): boolean {
  if (request.headers.get("dnt") === "1") return true;
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(";").some((pair) => pair.trim() === "forge_measure=off");
}

export { dayOf };

/** Today's salt, made on first use; every other day's is deleted. */
export function saltFor(db: Database, at: number): string {
  const day = dayOf(at);
  const found = db
    .query<{ salt: string }, [string]>("SELECT salt FROM vital_salt WHERE day = ?")
    .get(day);
  if (found !== null) return found.salt;
  const salt = new Bun.CryptoHasher("sha256")
    .update(crypto.getRandomValues(new Uint8Array(32)))
    .digest("hex");
  quietly(db, () => {
    db.run("DELETE FROM vital_salt WHERE day <> ?", [day]);
    db.run("INSERT OR IGNORE INTO vital_salt (day, salt) VALUES (?, ?)", [day, salt]);
    db.run("DELETE FROM page_vital WHERE at < ?", [at - KEEP_MS]);
  });
  return (
    db
      .query<{ salt: string }, [string]>("SELECT salt FROM vital_salt WHERE day = ?")
      .get(day)?.salt ?? salt
  );
}

/**
 * Store one report; false when the day is full and it was dropped. `client`
 * and `agent` go into the hash and nowhere else.
 */
export function recordVital(
  db: Database,
  report: Report,
  route: string,
  client: string,
  agent: string,
  at: number = Date.now(),
  dayMax: number = DAY_MAX,
): boolean {
  const held = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM page_vital WHERE day = ?")
    .get(dayOf(at));
  if ((held?.n ?? 0) >= dayMax) return false;
  const visitor = sha256(`${saltFor(db, at)}\0${client}\0${agent}`).slice(0, 32);
  quietly(db, () =>
    db.run(
      "INSERT INTO page_vital (day, at, route, visitor, ttfb, load, lcp, inp, cls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [dayOf(at), at, route, visitor, report.ttfb, report.load, report.lcp, report.inp, report.cls],
    ),
  );
  return true;
}
