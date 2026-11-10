/**
 * Home's row of figures (#2871, #2713), from `flow/kpis.ts`: shipped per
 * hour with a day's sparkline, the live version and since when, the median
 * check time, the crew builders running of their slots, the crew's spend
 * today of the daily ceiling, the age of the last off-box backup, who used the
 * answering time, browsers that reported back with 30 days as a sparkline,
 * accounts seen today, and reported page speed. What each one counts is in
 * `KPI_COUNTS`; `/api/v1/admin/kpis/probe` recomputes them.
 * Server-rendered, one fixed-height §5 stat tile each, so nothing moves when
 * it paints. Only the studio's words: shipped, change, check time.
 */

import type { Database } from "bun:sqlite";
import { KPI_COUNTS, backupFull, backupOverdue, backupValue, buildersValue, checkTime, shippedValue, vitalsNote, speedWords, spendCeilingWords, spendFull, spendValue, waitingWords } from "../../flow/kpi_words.ts";
import { perfRecord } from "../../perf/live.ts";
import type { TrafficClass, TrafficMinute, TrafficTotals } from "../../perf/traffic.ts";
import type { IdleReason } from "../../crew/idle_reason.ts";
import type { KpiTimer, Kpis } from "../../flow/kpis.ts";
import { cachedKpis, cachedWaiting } from "./home_cache.ts";
import { escapeHtml, html, raw, type Html } from "../html.ts";
import { BOOTED } from "../../release/gate.ts";
import { running } from "../../kernel/version.ts";
import { sha, stat, time } from "../ui.ts";
import type { User } from "../../core/users.ts";
import { reviewSetOf } from "./review_set.ts";
import { staleArchive } from "./review_stale.ts";

const W = 96;
const H = 24;

/** Day `i` of `n` at value `v` on a scale whose top is `top`: x spreads the days across W, y keeps 2 px clear at each edge. */
function at(i: number, n: number, v: number, top: number): [string, string] {
  const step = W / Math.max(1, n - 1);
  return [(i * step).toFixed(1), (H - 2 - (v / top) * (H - 4)).toFixed(1)];
}

function svg(label: string, body: string): Html {
  return raw(`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}">${body}</svg>`);
}

/** A series oldest first as a fixed-size SVG polyline; the numbers are the only input. */
function spark(series: readonly number[], label: string): Html {
  const top = Math.max(1, ...series);
  const points = series.map((v, i) => at(i, series.length, v, top).join(",")).join(" ");
  return svg(label, `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
}

/**
 * Days oldest first where `null` is a day with no data: the line breaks there
 * rather than dropping to zero. Each run of numbers is its own polyline on
 * the one shared scale, a run of one day is a dot, and no number at all is no
 * sparkline. Non-finite values count as missing.
 */
/** Outside a stat tile the caller wraps it in `<div class="bar muted">`: a flex row makes the svg a block (no baseline gap) and `.muted` colours it. */
export function daySpark(days: readonly (number | null)[], label: string): Html | null {
  const known = days.filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length === 0) return null;
  const top = Math.max(1, ...known);
  const runs: [string, string][][] = [];
  let run: [string, string][] = [];
  days.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push(at(i, days.length, v, top));
  });
  if (run.length > 0) runs.push(run);
  const body = runs
    .map((r) =>
      r.length === 1
        ? `<circle cx="${r[0]![0]}" cy="${r[0]![1]}" r="1.5" fill="currentColor"/>`
        : `<polyline points="${r.map((p) => p.join(",")).join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
    )
    .join("");
  return svg(escapeHtml(label), body);
}

/** The last 24 hours, newest first in, oldest on the left out. */
export function sparkline(hours: readonly number[]): Html {
  return spark([...hours].reverse(), "Shipped each hour over the last 24 hours");
}

/** Lightest first, stacked from the bottom: the strangers sit on top and read darkest. */
export const TRAFFIC_TONES: readonly (readonly [TrafficClass, string])[] = [
  ["internal", "0.12"],
  ["people", "0.25"],
  ["other", "0.45"],
  ["crawlers", "0.7"],
  ["deep", "1"],
];

/** The minutes as stacked columns of answering time, one tone per class; the numbers are the only input. */
export function trafficColumns(minutes: readonly TrafficMinute[], width: number, height: number, label: string): Html {
  const top = Math.max(1, ...minutes.map((m) => TRAFFIC_TONES.reduce((n, [c]) => n + m.classes[c].ms, 0)));
  const step = width / minutes.length;
  const rects = minutes.flatMap((m, i) => {
    let y = height;
    return TRAFFIC_TONES.map(([c, tone]) => {
      const h = (m.classes[c].ms / top) * height;
      y -= h;
      return h <= 0 ? "" : `<rect x="${(i * step).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, step - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="currentColor" fill-opacity="${tone}"/>`;
    });
  });
  return raw(`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(label)}">${rects.join("")}</svg>`);
}

function tile(label: string, href: string, value: Html | string, full: string, note: string | Html, title: string, extra: Html | null = null, tone: "attn" | null = null): Html {
  return stat({ label, href, value, title: full, note, noteTitle: title, aria: `${label}: ${full}, ${title}`, spark: extra, ...(tone === null ? {} : { tone }) });
}

/** The version this forge is running, and since when: the same source as `/releases`. */
export function liveNow(): { sha: string; at: string } | null {
  const commit = running().commit;
  return commit === null ? null : { sha: commit, at: BOOTED };
}

export function kpiRowFor(k: Kpis, live: { sha: string; at: string } | null, now: Date = new Date(), traffic: TrafficTotals | null = null): Html {
  const idle = k.builders.idle;
  const overdue = k.backup ? k.backup.state === "red" : backupOverdue(k.backupAt, now);
  const spendWords = spendCeilingWords(k.spend);
  const rate = shippedValue(k.landed, k.landedHours.length);
  return html`<section class="stats kpi-row mb" aria-label="The forge's figures, each over its own window; hover one for what it counts">
    ${tile(
      "Shipped per hour",
      "/board",
      rate,
      Number((k.landed / k.landedHours.length).toFixed(2)).toString(),
      `${k.landed} ${k.landed === 1 ? "change" : "changes"} in 24 h`,
      `${k.landed} ${k.landed === 1 ? "change" : "changes"} in 24 h. ${KPI_COUNTS.shipped}`,
      sparkline(k.landedHours),
    )}
    ${tile(
      "Live version",
      "/releases",
      live === null ? "—" : sha(live.sha),
      live === null ? "Nothing live yet" : live.sha,
      live === null ? "Nothing live yet" : html`live ${time(live.at)}`,
      live === null ? "Nothing live yet" : `Live since ${live.at}. ${KPI_COUNTS.live}`,
    )}
    ${tile(
      "Median check time",
      "/boards",
      checkTime(k.medianCheckMs),
      k.medianCheckMs === null ? "No check finished in 24 h" : checkTime(k.medianCheckMs),
      k.medianCheckMs === null ? "No check finished in 24 h" : "over the last 24 h",
      k.medianCheckMs === null ? "No check finished in 24 h" : KPI_COUNTS.checks,
    )}
    ${tile(
      "Builders running",
      idle?.href ?? "/settings/crew",
      buildersValue(k.builders),
      buildersValue(k.builders),
      k.builders.slots === 0 ? "No slots set" : idle?.word ?? "running now",
      k.builders.slots === 0 ? "No slots set" : `${KPI_COUNTS.builders} ${k.builders.slots} ${k.builders.slots === 1 ? "slot" : "slots"} set.`,
    )}
    ${tile(
      "Crew spend today",
      "/settings/crew",
      spendValue(k.spend),
      spendFull(k.spend),
      spendWords.note,
      spendWords.title,
      null,
      spendWords.attn ? "attn" : null,
    )}
    ${tile(
      "Last off-box backup",
      "/settings/backups",
      backupValue(k, now),
      backupFull(k.backupAt),
      k.backup ? k.backup.note : k.backupAt === null ? "no backup off the machine yet" : overdue ? "overdue, more than 24 h" : "off the machine",
      k.backup ? `${k.backup.reasons[0] ?? k.backup.unknowns[0] ?? k.backup.line} ${k.backup.checkLine}` : overdue ? "Overdue: the last off-box backup is more than 24 h old" : "Age of the last off-box backup",
      null,
      overdue ? "attn" : null,
    )}
    ${k.bugs === undefined ? null : tile(
      "Open bugs",
      "/boards",
      String(k.bugs.open),
      `${k.bugs.open} open ${k.bugs.open === 1 ? "bug" : "bugs"}`,
      k.bugs.overdue > 0 ? `${k.bugs.overdue} past its clock` : "none past its clock",
      "Open bugs, and those past their clock: 4 h high, 48 h otherwise",
      null,
      k.bugs.overdue > 0 ? "attn" : null,
    )}
    ${tile(
      "Reported page speed",
      "/boards/reach",
      speedWords(k.reach.loadP75),
      speedWords(k.reach.loadP75),
      vitalsNote(k.reach),
      KPI_COUNTS.speed,
    )}
  </section>`;
}

/** The figures count every repository, so the caller shows this to an admin only. */
export function kpiRow(db: Database, opts: { ceilingUsd?: number; dataDir?: string; idle?: () => IdleReason | null; now?: Date; time?: KpiTimer } = {}): Html {
  const now = opts.now ?? new Date();
  const forge = { ceilingUsd: opts.ceilingUsd ?? null, ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }), ...(opts.idle === undefined ? {} : { idle: opts.idle }) };
  // Read fresh from memory: no query, so it costs home nothing during a flood.
  return kpiRowFor(cachedKpis(db, now, forge, opts.time), liveNow(), now, perfRecord.ledger.totals(now.getTime()));
}

/**
 * One `.small .muted` line over `/review`: how many asks wait on the viewer
 * (the very set /review draws, stale ones left out) and how long the oldest has. Asks older than 30 days follow as
 * `N stale, archive?`, which opens the bulk-dismiss preview: nothing is
 * dismissed without a look. Empty when there is nothing to say.
 */
export function waitingLine(db: Database, user: User, now: Date = new Date()): Html {
  const { count, oldest, stale } = cachedWaiting(db, user.id, () => {
    const set = reviewSetOf(db, user, now);
    return {
      count: set.count,
      oldest: set.live.reduce<string | null>((o, a) => (o === null || Date.parse(a.since) < Date.parse(o) ? a.since : o), null),
      stale: set.stale.map((a) => ({ id: a.id })),
    };
  });
  const words = waitingWords(count, oldest, now);
  if (words === null && stale.length === 0) return html``;
  // `.break` lets the words wrap; `.stack` puts the link on its own line. No ask title: the home stays bare of them.
  // The fold is a form, which cannot sit in the paragraph: it follows it.
  return html`${words === null ? null : html`<p class="small muted break stack stack-tight"><span>${words}</span><a href="/review">Review them</a></p>`}${stale.length === 0 ? null : staleArchive(stale)}`;
}
