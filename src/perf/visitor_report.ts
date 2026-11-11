/**
 * The returning-visitor figures (#11265), read from `visitor` and
 * `visitor_visit`: new versus returning per day, the returning list, and for a
 * forge that was started or paid, the visits that led to it. Cookie ids and
 * probable ids are always counted apart: a probable visitor is never merged
 * with a cookie one. Plain data out.
 *
 * Counts: a day's visitor is a distinct visitor id with a visit that day; it is
 * new when its first_seen is that day, returning otherwise. In the totals a
 * returning visitor is one with two visits or more, last seen in the window.
 */

import type { Database } from "bun:sqlite";
import { dayOf } from "../web/measure.ts";
import { STEPS, type VisitorKind } from "./visitor_id.ts";

const DAY_MS = 86_400_000;
export const DAYS_MAX = 90;
export const LIST_MAX = 50;

export const daysOf = (raw: string | null): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= DAYS_MAX ? n : 30;
};

export interface DayCount {
  readonly day: string;
  readonly newCookie: number;
  readonly returningCookie: number;
  readonly newProbable: number;
  readonly returningProbable: number;
}

export interface Visitor {
  /** Shortened: the first 8 characters. */
  readonly id: string;
  readonly kind: VisitorKind;
  /** True for a probable id: shown as "probable" wherever it appears. */
  readonly probable: boolean;
  readonly visits: number;
  readonly daysSeen: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly firstRef: string;
  readonly lastRef: string;
  readonly step: string;
  readonly forge: string;
}

export interface Led {
  readonly forge: string;
  readonly id: string;
  readonly probable: boolean;
  readonly step: string;
  readonly firstSeen: string;
  readonly firstRef: string;
  readonly visits: readonly { readonly day: string; readonly ref: string; readonly pages: readonly string[] }[];
}

export interface VisitorsReport {
  readonly days: number;
  readonly perDay: readonly DayCount[];
  readonly newVisitors: number;
  readonly returningVisitors: number;
  readonly returning: readonly Visitor[];
  readonly led: readonly Led[];
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const shortId = (id: string): string => id.slice(0, 9);

interface Row {
  id: string;
  kind: VisitorKind;
  first_seen: number;
  last_seen: number;
  days_seen: number;
  visits: number;
  first_ref: string;
  last_ref: string;
  step: number;
  forge: string;
}

const asVisitor = (r: Row): Visitor => ({
  id: shortId(r.id),
  kind: r.kind,
  probable: r.kind === "probable",
  visits: r.visits,
  daysSeen: r.days_seen,
  firstSeen: iso(r.first_seen),
  lastSeen: iso(r.last_seen),
  firstRef: r.first_ref === "" ? "(direct)" : r.first_ref,
  lastRef: r.last_ref === "" ? "(direct)" : r.last_ref,
  step: STEPS[r.step] ?? "none",
  forge: r.forge,
});

/** The forges a visitor started or paid, with the visits that led to each: two queries however many forges. */
export function ledReport(db: Database): readonly Led[] {
  const forged = db.query<Row, []>("SELECT * FROM visitor WHERE forge <> '' ORDER BY linked_at DESC LIMIT 20").all();
  if (forged.length === 0) return [];
  const marks = forged.map(() => "?").join(",");
  const visits = new Map<string, { day: string; ref: string; pages: string[] }[]>();
  for (const v of db
    .query<{ visitor: string; day: string; entry_ref: string; pages: string }, string[]>(
      `SELECT visitor, day, entry_ref, pages FROM visitor_visit WHERE visitor IN (${marks}) ORDER BY id`,
    )
    .all(...forged.map((r) => r.id))) {
    const list = visits.get(v.visitor) ?? [];
    if (list.length < 20) list.push({ day: v.day, ref: v.entry_ref === "" ? "(direct)" : v.entry_ref, pages: JSON.parse(v.pages) as string[] });
    visits.set(v.visitor, list);
  }
  return forged.map((r) => ({
    forge: r.forge,
    id: shortId(r.id),
    probable: r.kind === "probable",
    step: STEPS[r.step] ?? "none",
    firstSeen: iso(r.first_seen),
    firstRef: r.first_ref === "" ? "(direct)" : r.first_ref,
    visits: visits.get(r.id) ?? [],
  }));
}

export function visitorsReport(db: Database, days: number, now: number): VisitorsReport {
  const since = dayOf(now - (days - 1) * DAY_MS);
  const per = db
    .query<{ day: string; kind: VisitorKind; fresh: number; n: number }, [string]>(
      `SELECT v.day AS day, w.kind AS kind, (strftime('%Y-%m-%d', w.first_seen / 1000, 'unixepoch') = v.day) AS fresh,
              COUNT(DISTINCT v.visitor) AS n
         FROM visitor_visit v JOIN visitor w ON w.id = v.visitor
        WHERE v.day >= ?1 GROUP BY v.day, w.kind, fresh`,
    )
    .all(since);
  const byDay = new Map<string, { nc: number; rc: number; np: number; rp: number }>();
  for (const r of per) {
    const d = byDay.get(r.day) ?? { nc: 0, rc: 0, np: 0, rp: 0 };
    if (r.kind === "cookie") r.fresh === 1 ? (d.nc += r.n) : (d.rc += r.n);
    else r.fresh === 1 ? (d.np += r.n) : (d.rp += r.n);
    byDay.set(r.day, d);
  }
  const perDay: DayCount[] = Array.from({ length: days }, (_, i) => {
    const day = iso(now - (days - 1 - i) * DAY_MS);
    const d = byDay.get(day) ?? { nc: 0, rc: 0, np: 0, rp: 0 };
    return { day, newCookie: d.nc, returningCookie: d.rc, newProbable: d.np, returningProbable: d.rp };
  });
  const cut = now - days * DAY_MS;
  const counts = db
    .query<{ fresh: number; n: number }, [number]>(
      "SELECT (visits = 1) AS fresh, COUNT(*) AS n FROM visitor WHERE last_seen >= ?1 GROUP BY fresh",
    )
    .all(cut);
  const returning = db
    .query<Row, [number]>(
      `SELECT * FROM visitor WHERE visits >= 2 AND last_seen >= ?1 ORDER BY visits DESC, last_seen DESC LIMIT ${LIST_MAX}`,
    )
    .all(cut)
    .map(asVisitor);
  const led = ledReport(db);
  return {
    days,
    perDay,
    newVisitors: counts.find((c) => c.fresh === 1)?.n ?? 0,
    returningVisitors: counts.find((c) => c.fresh === 0)?.n ?? 0,
    returning,
    led,
  };
}

/** The same counts by a different route: the probe proves a report's numbers against their rows, without building the report again. */
export function probeVisitors(
  db: Database,
  days: number,
  now: number,
  against: { readonly newVisitors: number; readonly returningVisitors: number },
): { readonly new: number; readonly returning: number; readonly agrees: boolean } {
  const cut = now - days * DAY_MS;
  const n = (where: string): number =>
    db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM visitor WHERE last_seen >= ?1 AND ${where}`).get(cut)?.n ?? 0;
  const fresh = n("visits = 1");
  const back = n("visits >= 2");
  return { new: fresh, returning: back, agrees: fresh === against.newVisitors && back === against.returningVisitors };
}
