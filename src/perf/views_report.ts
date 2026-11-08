/**
 * The traffic view's figures (#9427): visits made from the stored page views,
 * narrowed by a filter, summarised into the panels, and a path from a source
 * through named steps to a goal. Plain data in, plain data out.
 *
 * A visit is one visitor's views in one scope on one day: the visitor hash is
 * salted daily, so a visitor cannot be followed past midnight, and a return in
 * the same day is the same visit. Its source, medium and campaign are those of
 * its first view; its landing page is the first path and its exit the last.
 * Scrapers (`sources.ts` `isScraperAgent`) are counted apart and never in the
 * people's figures.
 */

import type { Database } from "bun:sqlite";

export const DAY_MS = 86_400_000;
export const WINDOWS = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type ViewWindow = keyof typeof WINDOWS;
export const windowOfViews = (raw: string | null): ViewWindow => (raw === "30d" || raw === "90d" ? raw : "7d");
/** The most views one read looks at. */
export const READ_MAX = 200_000;

export const DIMENSIONS = ["source", "medium", "campaign", "landing", "exit"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface Filter {
  readonly who: "people" | "scrapers";
  readonly source?: string;
  readonly medium?: string;
  readonly campaign?: string;
  readonly landing?: string;
  readonly exit?: string;
}

export interface Visit {
  readonly day: string;
  readonly visitor: string;
  readonly source: string;
  readonly medium: string;
  readonly campaign: string;
  readonly landing: string;
  readonly exit: string;
  readonly pages: number;
  /** Paths in order, each followed by `out:<host>` when that view carried a click. */
  readonly events: readonly string[];
  readonly outs: readonly string[];
  readonly scraper: boolean;
}

interface ViewRow {
  day: string;
  visitor: string;
  path: string;
  source: string;
  medium: string;
  campaign: string;
  out_host: string;
  scraper: number;
}

export const sinceOf = (now: number, window: ViewWindow): number => now - WINDOWS[window] * DAY_MS;

const HELD_MS = 15_000;
const held = new WeakMap<Database, Map<string, { at: number; visits: Visit[] }>>();

/** Forget the visits held for a short while; the store calls it after it writes. */
export const forgetVisits = (db: Database): void => void held.delete(db);

/**
 * The visits of a scope since a time. A read builds up to `READ_MAX` rows, so
 * the result is held for `HELD_MS` per scope and minute: a page and its probe
 * calls share one read, and a write (`forgetVisits`) drops what is held.
 */
export function readVisits(db: Database, scope: string, since: number): Visit[] {
  const key = `${scope}\0${Math.floor(since / 60_000)}`;
  let mine = held.get(db);
  if (mine === undefined) held.set(db, (mine = new Map()));
  const now = Date.now();
  const hit = mine.get(key);
  if (hit !== undefined && now - hit.at < HELD_MS) return hit.visits;
  if (mine.size >= 64) mine.clear();
  const visits = buildVisits(db, scope, since);
  mine.set(key, { at: now, visits });
  return visits;
}

function buildVisits(db: Database, scope: string, since: number): Visit[] {
  const rows = db
    .query<ViewRow, [string, number, number]>(
      `SELECT day, visitor, path, source, medium, campaign, out_host, scraper
         FROM traffic_view WHERE scope = ?1 AND at >= ?2 ORDER BY at, id LIMIT ?3`,
    )
    .all(scope, since, READ_MAX);
  const made = new Map<string, { first: ViewRow; last: ViewRow; events: string[]; outs: string[]; pages: number }>();
  for (const r of rows) {
    const key = `${r.day}\0${r.visitor}\0${r.scraper}`;
    let v = made.get(key);
    if (v === undefined) {
      v = { first: r, last: r, events: [], outs: [], pages: 0 };
      made.set(key, v);
    }
    v.last = r;
    v.pages += 1;
    v.events.push(r.path);
    if (r.out_host !== "") {
      v.events.push(`out:${r.out_host}`);
      v.outs.push(r.out_host);
    }
  }
  return [...made.values()].map((v) => ({
    day: v.first.day,
    visitor: v.first.visitor,
    source: v.first.source,
    medium: v.first.medium,
    campaign: v.first.campaign,
    landing: v.first.path,
    exit: v.last.path,
    pages: v.pages,
    events: v.events,
    outs: v.outs,
    scraper: v.first.scraper === 1,
  }));
}

export function matches(v: Visit, f: Filter): boolean {
  return (
    v.scraper === (f.who === "scrapers") &&
    (f.source === undefined || v.source === f.source) &&
    (f.medium === undefined || v.medium === f.medium) &&
    (f.campaign === undefined || v.campaign === f.campaign) &&
    (f.landing === undefined || v.landing === f.landing) &&
    (f.exit === undefined || v.exit === f.exit)
  );
}

export interface Counted {
  readonly key: string;
  readonly visits: number;
}

function tally(visits: readonly Visit[], of: (v: Visit) => string, limit = 10): Counted[] {
  const by = new Map<string, number>();
  for (const v of visits) by.set(of(v), (by.get(of(v)) ?? 0) + 1);
  return [...by]
    .map(([key, n]) => ({ key, visits: n }))
    .sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key))
    .slice(0, limit);
}

export interface SourcesReport {
  readonly visits: number;
  readonly pageViews: number;
  readonly pagesPerVisit: number;
  /** The same window's scrapers, whatever the filter. */
  readonly scrapers: number;
  readonly people: number;
  readonly days: readonly Counted[];
  readonly sources: readonly Counted[];
  readonly mediums: readonly Counted[];
  readonly campaigns: readonly Counted[];
  readonly landings: readonly Counted[];
  readonly exits: readonly Counted[];
  readonly outbound: readonly Counted[];
}

export const DIRECT = "(direct)";

export function sourcesReport(db: Database, scope: string, window: ViewWindow, filter: Filter, now: number): SourcesReport {
  const all = readVisits(db, scope, sinceOf(now, window));
  const mine = all.filter((v) => matches(v, filter));
  const pageViews = mine.reduce((n, v) => n + v.pages, 0);
  const days = Array.from({ length: WINDOWS[window] }, (_, i) =>
    new Date(sinceOf(now, window) + (i + 1) * DAY_MS).toISOString().slice(0, 10),
  );
  const perDay = new Map(tally(mine, (v) => v.day, 1000).map((c) => [c.key, c.visits]));
  const outs = new Map<string, number>();
  for (const v of mine) for (const o of v.outs) outs.set(o, (outs.get(o) ?? 0) + 1);
  return {
    visits: mine.length,
    pageViews,
    pagesPerVisit: mine.length === 0 ? 0 : Math.round((pageViews / mine.length) * 10) / 10,
    scrapers: all.filter((v) => v.scraper).length,
    people: all.filter((v) => !v.scraper).length,
    days: days.map((key) => ({ key, visits: perDay.get(key) ?? 0 })),
    sources: tally(mine, (v) => v.source || DIRECT),
    mediums: tally(mine.filter((v) => v.medium !== ""), (v) => v.medium),
    campaigns: tally(mine.filter((v) => v.campaign !== ""), (v) => v.campaign),
    landings: tally(mine, (v) => v.landing),
    exits: tally(mine, (v) => v.exit),
    outbound: [...outs].map(([key, visits]) => ({ key, visits })).sort((a, b) => b.visits - a.visits || a.key.localeCompare(b.key)),
  };
}

export interface FunnelStep {
  readonly step: string;
  readonly visits: number;
  /** Visits lost since the step before, and their share of it. */
  readonly lost: number;
  readonly lostShare: number;
}

export const STEPS_MAX = 6;
const STEP = /^(?:out:[a-z0-9.-]{1,253}|\/[A-Za-z0-9/_:.~%+-]{0,199})$/;

/** The steps a person typed: a path (a prefix, `/` meaning the front page only) or `out:<host>`. Invalid ones are dropped. */
export function parseSteps(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => STEP.test(s))
    .slice(0, STEPS_MAX);
}

const hit = (event: string, step: string): boolean =>
  step === "/" ? event === "/" : step.startsWith("out:") ? event === step : event === step || event.startsWith(step.endsWith("/") ? step : `${step}/`);

/** Visits that did each step in order (other pages may come between), with drop-off. The first row is every visit the filter keeps. */
export function funnel(db: Database, scope: string, window: ViewWindow, filter: Filter, steps: readonly string[], now: number): FunnelStep[] {
  const mine = readVisits(db, scope, sinceOf(now, window)).filter((v) => matches(v, filter));
  const progress = mine.map((v) => {
    let reached = 0;
    for (const e of v.events) if (reached < steps.length && hit(e, steps[reached]!)) reached += 1;
    return reached;
  });
  const rows: FunnelStep[] = [{ step: "From this source", visits: mine.length, lost: 0, lostShare: 0 }];
  let before = mine.length;
  steps.forEach((step, i) => {
    const n = progress.filter((p) => p > i).length;
    rows.push({ step, visits: n, lost: before - n, lostShare: before === 0 ? 0 : Math.round(((before - n) / before) * 100) });
    before = n;
  });
  return rows;
}
