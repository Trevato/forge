/**
 * Every flow read in one page: the reads under src/flow/ that nothing
 * else calls yet, each as one plain line, in a fixed order. `flowReadings`
 * is the raw values; `flowReportLines` words them. `publicOnly` is the rule every
 * read keeps: public repositories alone.
 */

import type { Database } from "bun:sqlite";
import { readBuildYield } from "./build_yield.ts";
import { readChecksPile } from "./checks_pile.ts";
import { readGateMinutes } from "./gate_minutes.ts";
import { readIdlePulls } from "./idle_pulls.ts";
import { readLeadTime } from "./lead_time.ts";
import { readOldestApproved } from "./oldest_approved.ts";
import { readOpeners } from "./openers.ts";
import { readOutsiders } from "./outsiders.ts";
import { readReviewLatency } from "./review_latency.ts";
import { readStaleReds } from "./stale_reds.ts";

/** The raw value of each read, keyed by its name, in report order. */
export function flowReadings(db: Database, now = new Date(), publicOnly = false) {
  return {
    build_yield: readBuildYield(db, now, publicOnly),
    review_latency: readReviewLatency(db, now, publicOnly),
    outsiders: readOutsiders(db, now, publicOnly),
    checks_pile: readChecksPile(db, publicOnly),
    stale_reds: readStaleReds(db, now, publicOnly),
    gate_minutes: readGateMinutes(db, now, publicOnly),
    oldest_approved: readOldestApproved(db, now, publicOnly),
    idle_pulls: readIdlePulls(db, now, publicOnly),
    lead_time: readLeadTime(db, now, publicOnly),
    openers: readOpeners(db, now, publicOnly),
  };
}

export type FlowReadings = ReturnType<typeof flowReadings>;

const hours = (h: number | null): string => (h === null ? "—" : `${Math.round(h * 10) / 10} h`);

/** One line per read: `name: words`. */
export function flowReportLines(r: FlowReadings): string[] {
  const y = r.build_yield;
  const g = r.gate_minutes;
  const o = r.oldest_approved;
  const l = r.lead_time;
  return [
    `build_yield: ${y.pushed} of ${y.finished} runs pushed in 24 h, ${y.landed} landed, ${y.closed} closed`,
    `review_latency: ${r.review_latency ? `median ${hours(r.review_latency.median)} over ${r.review_latency.count} pulls in 24 h` : "no first verdict in 24 h"}`,
    `outsiders: ${r.outsiders.open} open, oldest ${r.outsiders.oldestHours} h`,
    `checks_pile: ${r.checks_pile.red} red, ${r.checks_pile.queued} queued`,
    `stale_reds: ${r.stale_reds.count === 0 ? "none" : `${r.stale_reds.count} red with no run for 30 min, oldest ${hours(r.stale_reds.oldestHours)}`}`,
    `gate_minutes: gates ${g.gate1h} min in 1 h, ${g.gate6h} min in 6 h; pull checks ${g.pull1h} min in 1 h, ${g.pull6h} min in 6 h`,
    `oldest_approved: ${o ? `${o.repo}#${o.pull} approved ${hours(o.hours)} ago` : "none waiting"}`,
    `idle_pulls: ${r.idle_pulls.length === 0 ? "none" : r.idle_pulls.map((p) => `${p.repo}#${p.pull}${p.issue === null ? "" : ` (closes #${p.issue})`} ${hours(p.hours)}`).join(", ")}`,
    `lead_time: ${l.landed} landed in 24 h, median ${hours(l.medianHours)}, slowest ${hours(l.maxHours)}`,
    `openers: ${r.openers.length === 0 ? "none in 1 h" : r.openers.map((p) => `${p.author} ${p.opened} (${p.flow} flow)`).join(", ")}`,
  ];
}
