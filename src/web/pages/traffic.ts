/**
 * GET /settings/traffic: who is using the forge's answering time, from memory
 * alone (`perf/traffic.ts`). No git and no query of its own beyond the page's
 * chrome, so it stays quick while the forge is being flooded, which is when
 * it is wanted. Address prefixes are shown here and to no one but an admin.
 */

import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import {
  KPI_COUNTS,
  trafficAttention,
  trafficShare,
  TRAFFIC_WORDS,
} from "../../flow/kpi_words.ts";
import { perfRecord } from "../../perf/live.ts";
import {
  TRAFFIC_CLASSES,
  type TopRow,
  type TrafficTotals,
} from "../../perf/traffic.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { TRAFFIC_TONES, trafficColumns } from "../studio/kpi_row.ts";
import { card, empty } from "../ui.ts";
import { accountSections } from "./origins.ts";

const CHART_W = 600;
const CHART_H = 96;

const seconds = (ms: number): string =>
  `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

function classes(t: TrafficTotals): Html {
  return html`<div class="table-scroll">
    <table class="table" data-dense>
      <caption class="sr-only">
        Requests and answering time by who asked
      </caption>
      <thead>
        <tr>
          <th scope="col">Who</th>
          <th scope="col" class="num">Share of time</th>
          <th scope="col" class="num">Time</th>
          <th scope="col" class="num">Requests</th>
          <th scope="col" class="num">Refused</th>
        </tr>
      </thead>
      <tbody>
        ${TRAFFIC_CLASSES.map(
          (c) =>
            html`<tr>
              <td>${TRAFFIC_WORDS[c]}</td>
              <td class="num">${trafficShare(t, t.classes[c].ms)}</td>
              <td class="num">${seconds(t.classes[c].ms)}</td>
              <td class="num">${t.classes[c].requests}</td>
              <td class="num">${t.classes[c].refused}</td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function top(title: string, rows: readonly TopRow[], t: TrafficTotals): Html {
  return card(
    rows.length === 0
      ? html`<p class="muted small">None in the window.</p>`
      : html`<div class="table-scroll">
          <table class="table" data-dense>
            <caption class="sr-only">
              ${title}
            </caption>
            <thead>
              <tr>
                <th scope="col">${title}</th>
                <th scope="col" class="num">Share of time</th>
                <th scope="col" class="num">Requests</th>
                <th scope="col" class="num">Anonymous</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                (r) =>
                  html`<tr>
                    <td class="break">${r.key}</td>
                    <td class="num">${trafficShare(t, r.ms)}</td>
                    <td class="num">${r.requests}</td>
                    <td class="num">${r.anonymous}</td>
                  </tr>`,
              )}
            </tbody>
          </table>
        </div>`,
  );
}

function legend(): Html {
  return html`<p class="small muted">
    ${TRAFFIC_TONES.map(
      ([c, tone]) =>
        html`<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <rect
              width="10"
              height="10"
              fill="currentColor"
              fill-opacity="${tone}"
            ></rect>
          </svg>
          ${TRAFFIC_WORDS[c]} `,
    )}
  </p>`;
}

export function trafficPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const now = Date.now();
  const t = perfRecord.ledger.totals(now);
  const tops = perfRecord.ledger.tops(now);
  const wrong = trafficAttention(t);
  const body =
    t.requests === 0
      ? empty({
          icon: "users",
          title: "No requests in the last 15 minutes",
          note: "This process has answered nothing yet, or has just started: the figures are held in memory.",
        })
      : html`${wrong === null
            ? null
            : html`<p class="mb">
                <strong
                  >Something is wrong: ${TRAFFIC_WORDS[wrong]} took
                  ${trafficShare(t, t.classes[wrong].ms)} of the answering
                  time.</strong
                >
              </p>`}
          ${card(
            html`<p class="small muted mb">
                ${t.requests} requests, ${seconds(t.ms)} of answering time,
                ${t.refused} refused, about ${t.addresses} client
                ${t.addresses === 1 ? "address" : "addresses"}.
              </p>
              <div class="table-scroll muted">
                ${trafficColumns(
                  t.minutes,
                  CHART_W,
                  CHART_H,
                  "Answering time each minute over the last 15 minutes, by who asked",
                )}
              </div>
              ${legend()}${classes(t)}`,
          )}
          ${top("Repository read", tops.repos, t)}
          ${top("User agent", tops.families, t)}
          ${top("Address prefix", tops.prefixes, t)}
          <p class="small muted mt">
            ${KPI_COUNTS.traffic} Addresses are an estimate within about 3%:
            only each one's /16 or /32 is kept, in this process's memory.
          </p>`;
  return page({
    ctx,
    title: "Traffic",
    body: html`<div class="page-head"><h1>Traffic</h1></div>
      ${settingsLayout(
        accountSections("traffic", { admin: true }),
        body,
        "Account settings",
      )}`,
  });
}
