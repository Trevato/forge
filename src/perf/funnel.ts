/**
 * The selling funnel (#11259): visits to the anonymous home, views where the
 * plans came into view, clicks on each plan's button, forges made by a visitor,
 * entitlements that became active through a provider. Steps 1-4 are page views
 * of the scope `funnel` in `traffic_view` (so the same visitor hash, daily
 * salt, scraper flag, caps and 90-day retention as the traffic view, and no
 * personal data); the path names the step: `home`, `plans`, `click:<plan>`,
 * `forge`. Step 5 is read from `entitlement_change`, where the provider wrote it.
 *
 * Counting: steps 1-3 count people (a visitor-day once), the forge step counts
 * forges, the paid step counts changes. Scrapers are never counted. The
 * percentage is a step over the step before it.
 */

import type { Database } from "bun:sqlite";
import type { Origin } from "./sources.ts";
import { flushViews, noteView } from "./views_store.ts";
import { DAY_MS } from "./views_report.ts";

export const FUNNEL_SCOPE = "funnel";
export const FUNNEL_DAYS_MAX = 90;
export const NO_ORIGIN: Origin = { refHost: "", source: "", medium: "", campaign: "", out: "" };

export type StepKind = "home" | "plans" | "click" | "forge";

export interface Step {
  readonly id: "home" | "plans" | "click" | "forge" | "paid";
  readonly label: string;
  readonly count: number;
  /** Share of the step before, in percent with one decimal; null for the first or when that was zero. */
  readonly pct: number | null;
}

export interface FunnelReport {
  readonly as_of: string;
  readonly days: number;
  readonly steps: Step[];
  readonly clicks_by_plan: { plan: string; count: number }[];
  /** Where visits that clicked a plan came from, top 5; "(direct)" when no referrer or campaign. */
  readonly referrers: { source: string; count: number }[];
}

/** `days` from the query: a whole number 1..90, else 7. */
export function daysOf(raw: string | null): number {
  const n = raw !== null && /^\d{1,3}$/.test(raw) ? Number(raw) : 7;
  return n >= 1 && n <= FUNNEL_DAYS_MAX ? n : 7;
}

export const pathOf = (kind: StepKind, plan = ""): string => (kind === "click" ? `click:${plan.slice(0, 60)}` : kind);

/** Note one step for a visitor; no SQL (the view buffer). */
export function noteStep(
  db: Database,
  step: { kind: StepKind; plan?: string; client: string; agent: string; origin?: Origin; at?: number },
): boolean {
  return noteView(db, {
    scope: FUNNEL_SCOPE,
    path: pathOf(step.kind, step.plan),
    origin: step.origin ?? NO_ORIGIN,
    client: step.client,
    agent: step.agent,
    ...(step.at === undefined ? {} : { at: step.at }),
  });
}

const pct = (n: number, of: number): number | null => (of === 0 ? null : Math.round((n * 1000) / of) / 10);

/** Entitlements that became active through a provider since `since`: the sql route and the row route agree by construction of the probe. */
export function paidSql(db: Database, since: number): number {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM entitlement_change c
          WHERE c.at >= ?1 AND c.to_status = 'active' AND (c.from_status != 'active' OR c.from_plan != c.to_plan)
            AND EXISTS (SELECT 1 FROM entitlement e WHERE e.forge = c.forge AND e.provider NOT IN ('none', ''))`,
      )
      .get(new Date(since).toISOString())?.n ?? 0
  );
}

interface Row {
  day: string;
  visitor: string;
  path: string;
  source: string;
}

export function funnelReport(db: Database, days: number, now: number = Date.now()): FunnelReport {
  flushViews(db, now);
  const since = now - days * DAY_MS;
  const rows = db
    .query<Row, [string, number]>(
      "SELECT day, visitor, path, source FROM traffic_view WHERE scope = ?1 AND at >= ?2 AND scraper = 0 ORDER BY at, id",
    )
    .all(FUNNEL_SCOPE, since);
  const people = { home: new Set<string>(), plans: new Set<string>(), click: new Set<string>() };
  const byPlan = new Map<string, Set<string>>();
  const sourceOf = new Map<string, string>();
  let forges = 0;
  for (const r of rows) {
    const who = `${r.day}\0${r.visitor}`;
    if (r.path === "home") {
      people.home.add(who);
      if (!sourceOf.has(who)) sourceOf.set(who, r.source);
    } else if (r.path === "plans") people.plans.add(who);
    else if (r.path === "forge") forges += 1;
    else if (r.path.startsWith("click:")) {
      people.click.add(who);
      const plan = r.path.slice(6);
      let set = byPlan.get(plan);
      if (set === undefined) byPlan.set(plan, (set = new Set()));
      set.add(who);
    }
  }
  const sources = new Map<string, number>();
  for (const who of people.click) {
    const s = sourceOf.get(who) || "(direct)";
    sources.set(s, (sources.get(s) ?? 0) + 1);
  }
  const counts = [people.home.size, people.plans.size, people.click.size, forges, paidSql(db, since)];
  const labels: [Step["id"], string][] = [
    ["home", "Visits to home"],
    ["plans", "Saw the plans"],
    ["click", "Clicked a plan"],
    ["forge", "Forges made"],
    ["paid", "Paid"],
  ];
  const top = <T extends { count: number }>(list: T[], key: (t: T) => string, n: number): T[] =>
    list.sort((a, b) => b.count - a.count || key(a).localeCompare(key(b))).slice(0, n);
  return {
    as_of: new Date(now).toISOString(),
    days,
    steps: labels.map(([id, label], i) => ({ id, label, count: counts[i]!, pct: i === 0 ? null : pct(counts[i]!, counts[i - 1]!) })),
    clicks_by_plan: top([...byPlan].map(([plan, s]) => ({ plan, count: s.size })), (t) => t.plan, 50),
    referrers: top([...sources].map(([source, count]) => ({ source, count })), (t) => t.source, 5),
  };
}
