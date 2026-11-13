/**
 * The provider's own measurement of a window (#8960): Claude Code reports,
 * as a session runs, how much of the 5-hour or weekly limit is used and when
 * it resets. The percent is kept as the provider said it; no dollar is ever
 * turned into percent here. Pure data: no authz, no events.
 */

import type { Database } from "bun:sqlite";
import type { LimitWindow } from "./standing.ts";

/** One measurement: percent of the window used, 0..100, and the window's reset. */
export interface Measure {
  readonly window: LimitWindow;
  readonly usedPct: number;
  readonly resetsAt: string;
  readonly observedAt: string;
}

/**
 * The measurement in a Claude Code `rate_limit_event` record, or undefined
 * when it carries none. Assumed shape: `rate_limit_info` holds
 * `rateLimitType` (`five_hour` | `seven_day`), `resetsAt` in unix seconds and
 * `utilization` as a fraction 0..1 of the limit (the provider omits it
 * until a threshold is near; then there is no measurement).
 */
export function measureOf(event: Record<string, unknown>, now: Date): Measure | undefined {
  if (event["type"] !== "rate_limit_event") return undefined;
  const info = event["rate_limit_info"];
  if (typeof info !== "object" || info === null) return undefined;
  const i = info as Record<string, unknown>;
  const window: LimitWindow | undefined =
    i["rateLimitType"] === "seven_day" ? "week" : i["rateLimitType"] === "five_hour" ? "5h" : undefined;
  const used = i["utilization"];
  const resets = i["resetsAt"];
  if (window === undefined || typeof used !== "number" || !(used >= 0 && used <= 1)) return undefined;
  if (typeof resets !== "number" || !Number.isFinite(resets) || resets <= 0) return undefined;
  return {
    window,
    usedPct: Math.round(used * 1000) / 10,
    resetsAt: new Date(resets * 1000).toISOString(),
    observedAt: now.toISOString(),
  };
}

/**
 * How long a measurement is believed. The provider only reports a window when
 * a threshold is near, so a reading of 99% is never followed by "you are at
 * 5% again": on 2026-11-13 the owner reset his week and the forge held the
 * crew at "99% used" for twenty hours, and a held crew makes no run that
 * could hear otherwise. Past this age the reading is dropped; the next run
 * is the probe, and if the limit is real the provider says so again.
 */
export const MEASURE_TRUST_MS = 6 * 3_600_000;

/**
 * The window a `rate_limit_event` speaks of when it carries NO utilization:
 * the provider's way of saying that window is under its thresholds. A stored
 * reading for it is then stale.
 */
export function clearedOf(event: Record<string, unknown>): LimitWindow | undefined {
  if (event["type"] !== "rate_limit_event") return undefined;
  const info = event["rate_limit_info"];
  if (typeof info !== "object" || info === null) return undefined;
  const i = info as Record<string, unknown>;
  if (typeof i["utilization"] === "number") return undefined;
  if (typeof i["status"] === "string" && i["status"] !== "allowed") return undefined;
  return i["rateLimitType"] === "seven_day" ? "week" : i["rateLimitType"] === "five_hour" ? "5h" : undefined;
}

/** Drop the stored reading of a window: the provider has since said it is under its thresholds. */
export function forgetMeasure(db: Database, subscriptionId: string, window: LimitWindow): void {
  db.query("DELETE FROM subscription_measure WHERE subscription_id = ?1 AND span = ?2").run(subscriptionId, window);
}

/** The newest word for a window replaces the last; an unknown subscription is ignored. */
export function noteMeasure(db: Database, subscriptionId: string, m: Measure): void {
  db.query(
    `INSERT INTO subscription_measure (subscription_id, span, used_pct, resets_at, observed_at)
     SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM subscription WHERE id = ?1)
     ON CONFLICT (subscription_id, span) DO UPDATE SET
       used_pct = excluded.used_pct, resets_at = excluded.resets_at, observed_at = excluded.observed_at`,
  ).run(subscriptionId, m.window, m.usedPct, m.resetsAt, m.observedAt);
}

/** The measurement of `window` for a subscription whose reset is still ahead of `now`; null when none. */
export function measureFor(db: Database, subscriptionId: string, window: LimitWindow, now: Date): Measure | null {
  const row = db
    .query<{ used_pct: number; resets_at: string; observed_at: string }, [string, string]>(
      "SELECT used_pct, resets_at, observed_at FROM subscription_measure WHERE subscription_id = ?1 AND span = ?2",
    )
    .get(subscriptionId, window);
  if (row === null || Date.parse(row.resets_at) <= now.getTime()) return null;
  if (now.getTime() - Date.parse(row.observed_at) > MEASURE_TRUST_MS) return null;
  return { window, usedPct: row.used_pct, resetsAt: row.resets_at, observedAt: row.observed_at };
}
