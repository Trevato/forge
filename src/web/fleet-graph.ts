/**
 * The fleet graph drawn: for each window, spend stacked per series above
 * runs stacked per series, on one time axis — SVG written here on the
 * server, no chart library, no client drawing. Beside it, the same numbers
 * as a table, which is also what a screen reader is pointed at.
 *
 * Scales, stated once: a bar's height is its value over the panel's top
 * tick times the panel's height (`SPEND_H`, `RUNS_H` px), and the top tick
 * is the smallest 1, 2, 2.5 or 5 × 10ⁿ at or above the tallest stack
 * (`niceCeiling`). Colours are the Okabe–Ito palette, chosen to be told
 * apart with the common colour-vision deficiencies; the folded "others"
 * series is grey. They are classes (`fg-s0`…), set in the stylesheet from
 * the `--series-N` tokens in `src/design/themes.ts`. Text is sized here in
 * viewBox units, beside the geometry it has to fit, not in the stylesheet.
 *
 * `fleetGraphSection` carries `data-src`: the client script below fetches
 * it when the page's one `/events` stream (`forge:event`) carries a kind in
 * `FLEET_GRAPH_EVENTS`, at most once a second, and when the tab becomes
 * visible. There is no timer: a quiet forge never redraws, which is correct
 * because nothing moved. The fragment route returns this same section.
 */

import {
  FLEET_GRAPH_MAX_REPOS,
  type FleetGraph,
  type FleetWindow,
} from "../actions/fleet-graph.ts";
import { html, type Html } from "./html.ts";
import { seriesDot } from "./ui.ts";

export const SVG_W = 600;
const LEFT = 48;
const RIGHT = 8;
const TOP = 10;
export const SPEND_H = 120;
const GAP = 22;
export const RUNS_H = 60;
const AXIS = 18;
const SVG_H = TOP + SPEND_H + GAP + RUNS_H + AXIS;
const PLOT_W = SVG_W - LEFT - RIGHT;

/**
 * The event kinds that move spend or runs: a run starting, a spend tick
 * mid-run (the runner records a `running` usage row and appends
 * `usage.delta`), and a run ending. The one-second coalescing below is what
 * keeps the tick rate cheap.
 */
export const FLEET_GRAPH_EVENTS: readonly string[] = [
  "run.started",
  "usage.delta",
  "run.finished",
];

/** Redraws are coalesced to at most one in this many ms. */
export const FLEET_GRAPH_MIN_GAP_MS = 1000;

/** The smallest 1, 2, 2.5 or 5 × 10ⁿ at or above `v`; `floor` when v is 0. */
export function niceCeiling(v: number, floor: number): number {
  if (!(v > 0)) return floor;
  const step = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v - 1e-12) return m * step;
  return 10 * step;
}

export const money = (n: number): string => `$${n.toFixed(2)}`;

/** A tick's words: dollars to as many places as the step needs. */
const moneyTick = (n: number): string =>
  n >= 10 || Number.isInteger(n) ? `$${Math.round(n)}` : `$${n.toFixed(n < 0.1 ? 3 : n < 1 ? 2 : 1)}`;

/** `14:00` for an hour, `10-02` for a day — UTC either way. */
const bucketWords = (w: FleetWindow, start: string): string =>
  w.unit === "hour" ? `${start.slice(11, 13)}:00` : start.slice(5, 10);

const bucketTitle = (w: FleetWindow, start: string): string =>
  w.unit === "hour"
    ? `${start.slice(0, 10)} ${start.slice(11, 13)}:00 UTC`
    : `${start.slice(0, 10)} UTC`;

const r2 = (n: number): string => String(Math.round(n * 100) / 100);

/** One window as an SVG: spend panel, runs panel, a shared axis. */
export function windowSvg(graph: FleetGraph, w: FleetWindow): Html {
  const n = w.buckets.length;
  const slot = PLOT_W / n;
  const bar = Math.max(slot * 0.72, 1);
  const stack = (k: "costUsd" | "runs") =>
    Math.max(0, ...w.buckets.map((b) => b[k].reduce((s, v) => s + v, 0)));
  const spendTop = niceCeiling(stack("costUsd"), 1);
  const runsTop = niceCeiling(stack("runs"), 1);
  const runsTopWhole = Math.max(Math.ceil(runsTop), 1);
  const spendY0 = TOP + SPEND_H;
  const runsY0 = TOP + SPEND_H + GAP + RUNS_H;
  const every = w.unit === "hour" ? 6 : 3;
  const totalSpend = w.totals.costUsd.reduce((s, v) => s + v, 0);
  const totalRuns = w.totals.runs.reduce((s, v) => s + v, 0);
  const label = `${w.name === "24h" ? "Last 24 hours by hour" : "Last 14 days by day"}: ${money(totalSpend)} over ${totalRuns} ${totalRuns === 1 ? "run" : "runs"}`;

  const segments = (
    k: "costUsd" | "runs",
    top: number,
    height: number,
    y0: number,
  ): Html[] =>
    w.buckets.flatMap((b, i) => {
      const x = LEFT + i * slot + (slot - bar) / 2;
      let y = y0;
      return graph.series.flatMap((s, si) => {
        const v = b[k][si] ?? 0;
        if (v <= 0) return [];
        const h = (v / top) * height;
        y -= h;
        const words =
          k === "costUsd"
            ? `${s.label} · ${bucketTitle(w, b.start)} · ${money(v)}`
            : `${s.label} · ${bucketTitle(w, b.start)} · ${v} ${v === 1 ? "run" : "runs"}${b.failed[si] ? `, ${b.failed[si]} failed` : ""}`;
        return [
          html`<rect class="fg-s${si}" data-series="${si}" data-bucket="${b.start}" data-${k === "costUsd" ? "spend" : "runs"}="${r2(v)}" x="${r2(x)}" y="${r2(y)}" width="${r2(bar)}" height="${r2(h)}"><title>${words}</title></rect>`,
        ];
      });
    });

  return html`<svg
    class="plot"
    viewBox="0 0 ${SVG_W} ${SVG_H}"
    width="${SVG_W}"
    height="${SVG_H}"
    preserveAspectRatio="xMinYMin meet"
    font-size="10"
    role="img"
    aria-label="${label}"
    data-window="${w.name}"
    data-spend-top="${spendTop}"
    data-runs-top="${runsTopWhole}"
  >
    <g>
      <line x1="${LEFT}" y1="${TOP}" x2="${SVG_W - RIGHT}" y2="${TOP}" />
      <line x1="${LEFT}" y1="${TOP + SPEND_H / 2}" x2="${SVG_W - RIGHT}" y2="${TOP + SPEND_H / 2}" />
      <line x1="${LEFT}" y1="${spendY0}" x2="${SVG_W - RIGHT}" y2="${spendY0}" />
      <line x1="${LEFT}" y1="${runsY0 - RUNS_H}" x2="${SVG_W - RIGHT}" y2="${runsY0 - RUNS_H}" />
      <line x1="${LEFT}" y1="${runsY0}" x2="${SVG_W - RIGHT}" y2="${runsY0}" />
    </g>
    <g text-anchor="end">
      <text x="${LEFT - 6}" y="${TOP + 4}">${moneyTick(spendTop)}</text>
      <text x="${LEFT - 6}" y="${TOP + SPEND_H / 2 + 4}">${moneyTick(spendTop / 2)}</text>
      <text x="${LEFT - 6}" y="${spendY0 + 4}">$0</text>
      <text x="${LEFT - 6}" y="${runsY0 - RUNS_H + 4}">${runsTopWhole}</text>
      <text x="${LEFT - 6}" y="${runsY0 + 4}">0</text>
    </g>
    <g class="plot-name">
      <text x="${LEFT + 4}" y="${TOP + 12}">spend, USD</text>
      <text x="${LEFT + 4}" y="${runsY0 - RUNS_H + 12}">runs ended</text>
    </g>
    <g>
      ${segments("costUsd", spendTop, SPEND_H, spendY0)}
      ${segments("runs", runsTopWhole, RUNS_H, runsY0)}
    </g>
    <g text-anchor="middle">
      ${w.buckets.map((b, i) =>
        (n - 1 - i) % every === 0
          ? html`<text x="${r2(LEFT + i * slot + slot / 2)}" y="${runsY0 + 14}">${bucketWords(w, b.start)}</text>`
          : null,
      )}
    </g>
  </svg>`;
}

/** The legend: one swatch per series, with its 14-day spend. */
function legend(graph: FleetGraph): Html {
  const fortnight = graph.windows[1];
  return html`<ul class="plot-legend">
    ${graph.series.map(
      (s, i) =>
        html`<li title="${s.repos.join(", ")}">
          ${seriesDot(i)}
          ${s.repos.length === 1
            ? html`<a href="/${s.label}">${s.label}</a>`
            : s.label}
          <span class="muted">${money(fortnight.totals.costUsd[i] ?? 0)}</span>
        </li>`,
    )}
  </ul>`;
}

/** Every repository's own figures, the chart's numbers as text. */
function table(graph: FleetGraph): Html {
  return html`<div class="table-scroll">
    <table class="table" data-dense>
      <caption class="sr-only">
        Spend and runs per repository, last 24 hours and last 14 days
      </caption>
      <thead>
        <tr>
          <th scope="col">repository</th>
          <th scope="col" class="num">24 h spend</th>
          <th scope="col" class="num">24 h runs</th>
          <th scope="col" class="num">14 d spend</th>
          <th scope="col" class="num">14 d runs</th>
          <th scope="col" class="num">14 d failed</th>
        </tr>
      </thead>
      <tbody>
        ${graph.repos.map(
          (r) => html`<tr data-repo="${r.repo}">
            <th scope="row">
              ${seriesDot(r.series)}
              <a href="/${r.repo}">${r.repo}</a>
            </th>
            <td class="num">${money(r.day.costUsd)}</td>
            <td class="num">${r.day.runs}</td>
            <td class="num">${money(r.fortnight.costUsd)}</td>
            <td class="num">${r.fortnight.runs}</td>
            <td class="num">${r.fortnight.failed}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

/** Built as text, so no markup whitespace lands inside the sentence. */
const hiddenWords = (n: number): string =>
  `${n} of the names asked for ${n === 1 ? "is" : "are"} not shown: missing, or not yours to see spend for.`;

/** The query string that reproduces this selection. */
export function selectionQuery(graph: FleetGraph): string {
  return graph.asked === null
    ? ""
    : graph.asked.map((n) => `repo=${encodeURIComponent(n)}`).join("&");
}

/**
 * The way to the graph from another page, already holding what that page
 * shows: one `repo=` per owner/name, each URL-encoded. None is every
 * repository the viewer may write, the graph's own default. The graph
 * re-validates the names (`fleetSelection`); this only spells them.
 */
export function fleetGraphHref(names: readonly string[]): string {
  const q = [...new Set(names)]
    .map((n) => `repo=${encodeURIComponent(n)}`)
    .join("&");
  return q === "" ? "/fleet/graph" : `/fleet/graph?${q}`;
}

/**
 * The graph for a page that may be narrowed: not narrowed is the graph's
 * default, the viewer's own; narrowed is exactly those names, and none (or
 * more than one graph holds) is no link, so a link never widens or quietly
 * cuts what the page showed.
 */
export function narrowedGraphHref(
  narrowed: boolean,
  names: readonly string[],
): string | null {
  if (!narrowed) return fleetGraphHref([]);
  if (names.length === 0 || names.length > FLEET_GRAPH_MAX_REPOS) return null;
  return fleetGraphHref(names);
}

/**
 * The whole graph: legend, both windows, the table and what it assumes. The
 * same markup the live fragment returns, so a redraw replaces it whole.
 */
export function fleetGraphSection(graph: FleetGraph): Html {
  const q = selectionQuery(graph);
  return html`<section
    id="fleet-graph"
    data-src="/fleet/graph/live${q === "" ? "" : `?${q}`}"
    data-at="${graph.at}"
  >
    ${graph.repos.length === 0
      ? html`<p class="muted">
          ${graph.asked === null
            ? "No repository you can write spent anything in the last 14 days."
            : "None of these repositories is yours to see spend for."}
        </p>`
      : html`${legend(graph)}
          <div class="plots">
            ${graph.windows.map(
              (w) => html`<figure>
                <figcaption>
                  ${w.name === "24h" ? "Last 24 hours" : "Last 14 days"}
                  <span class="muted"
                    >${money(w.totals.costUsd.reduce((s, v) => s + v, 0))} ·
                    ${w.totals.runs.reduce((s, v) => s + v, 0)} runs</span
                  >
                </figcaption>
                ${windowSvg(graph, w)}
              </figure>`,
            )}
          </div>
          ${table(graph)}`}
    ${graph.hidden > 0
      ? html`<p class="muted small">${hiddenWords(graph.hidden)}</p>`
      : null}
    <p class="muted small mt">
      Read from the usage ledger at
      <time datetime="${graph.at}">${graph.at.slice(11, 16)} UTC</time>. A
      run counts in the UTC hour or day it ended; spend is the provider's
      reported cost in US dollars. The newest bar is still filling. Redrawn
      when spend or runs move while open.
    </p>
  </section>`;
}

/** The redraw: fetch the fragment, swap the section; pure enhancement. */
export const fleetGraphClientJs = /* js */ `
(function () {
  var busy = false;
  function redraw() {
    var el = document.getElementById('fleet-graph');
    if (!el || busy) return;
    var src = el.getAttribute('data-src');
    if (!src) return;
    busy = true;
    fetch(src, { credentials: 'same-origin', headers: { accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        if (text === null) return;
        var doc = new DOMParser().parseFromString(text, 'text/html');
        var next = doc.getElementById('fleet-graph');
        var now = document.getElementById('fleet-graph');
        if (next && now) now.replaceWith(document.importNode(next, true));
      })
      .catch(function () {})
      .then(function () { busy = false; });
  }
  var kinds = ${JSON.stringify(FLEET_GRAPH_EVENTS)};
  var last = 0;
  var timer = null;
  // At most one redraw a second: a burst of events draws once, trailing.
  function soon() {
    if (timer !== null) return;
    timer = setTimeout(function () {
      timer = null;
      last = Date.now();
      redraw();
    }, Math.max(0, last + ${FLEET_GRAPH_MIN_GAP_MS} - Date.now()));
  }
  document.addEventListener('forge:event', function (e) {
    var kind = e.detail && e.detail.kind;
    if (kinds.indexOf(kind) !== -1) soon();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') redraw();
  });
})();
`;
