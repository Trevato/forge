/**
 * What the old home's row of tiles left that other pages still use: the day
 * sparkline and the traffic columns (`daySpark`, `trafficColumns`), the live
 * version (`liveNow`), and the line that counts what waits on a person
 * (`waitingLine`, the feed's). The home itself is `pages/home_flow.ts`, with
 * its figures in `pages/home_figures.ts`.
 */

import type { Database } from "bun:sqlite";
import { waitingWords } from "../../flow/kpi_words.ts";

import type { TrafficClass, TrafficMinute } from "../../perf/traffic.ts";

import { cachedWaiting } from "./home_cache.ts";
import { escapeHtml, html, raw, type Html } from "../html.ts";
import { BOOTED } from "../../release/gate.ts";
import { running } from "../../kernel/version.ts";

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

/** The version this forge is running, and since when: the same source as `/releases`. */
export function liveNow(): { sha: string; at: string } | null {
  const commit = running().commit;
  return commit === null ? null : { sha: commit, at: BOOTED };
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
