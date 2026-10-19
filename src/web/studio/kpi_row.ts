/**
 * Home's row of three figures (#2871), from `flow/kpis.ts`: shipped per hour
 * with a day's sparkline, the live version and since when, and the median
 * check time. Server-rendered, one fixed-height card each, so nothing moves
 * when it paints. Only the studio's words: shipped, change, check time.
 */

import type { Database } from "bun:sqlite";
import { checkTime } from "../../flow/kpi_words.ts";
import { readKpis, type Kpis } from "../../flow/kpis.ts";
import { html, raw, type Html } from "../html.ts";
import { BOOTED } from "../../release/gate.ts";
import { running } from "../../kernel/version.ts";
import { sha, time } from "../ui.ts";

const W = 96;
const H = 24;

/** The last 24 hours, oldest on the left, as an SVG polyline; the numbers are the only input. */
export function sparkline(hours: readonly number[]): Html {
  const series = [...hours].reverse();
  const top = Math.max(1, ...series);
  const step = W / Math.max(1, series.length - 1);
  const points = series
    .map((v, i) => `${(i * step).toFixed(1)},${(H - 2 - (v / top) * (H - 4)).toFixed(1)}`)
    .join(" ");
  return raw(
    `<svg class="kpi-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Shipped each hour over the last 24 hours"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`,
  );
}

function tile(label: string, href: string, value: Html | string, note: string | Html, title: string, extra: Html | null = null): Html {
  return html`<a class="card kpi" href="${href}">
    <span class="small muted">${label}</span>
    <span class="kpi-value num">${value}</span>
    <span class="kpi-note small muted" title="${title}">${note}</span>
    ${extra}
  </a>`;
}

/** The version this forge is running, and since when: the same source as `/releases`. */
export function liveNow(): { sha: string; at: string } | null {
  const commit = running().commit;
  return commit === null ? null : { sha: commit, at: BOOTED };
}

export function kpiRowFor(k: Kpis, live: { sha: string; at: string } | null): Html {
  const rate = k.landed / k.landedHours.length;
  return html`<section class="kpis" aria-label="The last 24 hours, as of this page load">
    ${tile(
      "Shipped per hour",
      "/board",
      rate.toFixed(1),
      `${k.landed} ${k.landed === 1 ? "change" : "changes"} in 24 h`,
      `${k.landed} ${k.landed === 1 ? "change" : "changes"} in 24 h`,
      sparkline(k.landedHours),
    )}
    ${tile(
      "Live version",
      "/releases",
      live === null ? "—" : sha(live.sha),
      live === null ? "Nothing live yet" : html`live ${time(live.at)}`,
      live === null ? "Nothing live yet" : `Live since ${live.at}`,
    )}
    ${tile(
      "Median check time",
      "/boards",
      checkTime(k.medianCheckMs),
      k.medianCheckMs === null ? "No check finished in 24 h" : "over the last 24 h",
      k.medianCheckMs === null ? "No check finished in 24 h" : "over the last 24 h",
    )}
  </section>`;
}

/** The figures count every repository, so the caller shows this to an admin only. */
export function kpiRow(db: Database, now = new Date()): Html {
  return kpiRowFor(readKpis(db, now), liveNow());
}
