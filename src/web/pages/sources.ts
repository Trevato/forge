/**
 * Where people come from and where they go (#9427): one view for the forge
 * (`/settings/traffic/sources`, admin) and one per app
 * (`/:owner/:name/settings/app/traffic`, those who administer it). Visits over
 * time, sources, mediums, campaigns, landing pages and exits; choosing a value
 * narrows every other panel; a path from a source through named steps to a
 * goal; GitHub's own traffic for the forge. Every number links to the probe
 * (`/api/v1/admin/traffic/probe`) that counts it again another way. Built from
 * stored views (`perf/views_store.ts`) in one indexed read.
 */

import { getAppById } from "../../core/apps.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { githubSummary } from "../../perf/github_traffic.ts";
import { outboundNames } from "../../perf/sources.ts";
import {
  DIMENSIONS,
  DIRECT,
  WINDOWS,
  funnel,
  parseSteps,
  sinceOf,
  sourcesReport,
  windowOfViews,
  type Counted,
  type Dimension,
  type Filter,
  type ViewWindow,
} from "../../perf/views_report.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { escapeHtml, html, raw, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, seg } from "../ui.ts";
import { accountSections } from "./origins.ts";
import { settingsPageResponse, timedAdminRepo } from "./settings.ts";
import { getAppByRepo } from "../../core/apps.ts";

const CHART_W = 600;
const CHART_H = 72;
const PROBE = "/api/v1/admin/traffic/probe";

interface Query {
  readonly scope: string;
  readonly base: string;
  readonly extra: Record<string, string>;
  readonly window: ViewWindow;
  readonly filter: Filter;
  readonly steps: string[];
}

const text = (v: string | null): string | undefined => (v !== null && v.length > 0 && v.length <= 200 ? v : undefined);

function queryOf(url: URL, scope: string, base: string, extra: Record<string, string>): Query {
  const p = url.searchParams;
  const pick = (k: string): { [k: string]: string } => {
    const v = text(p.get(k));
    return v === undefined ? {} : { [k]: v };
  };
  const source = p.get("source") === DIRECT ? { source: "" } : pick("source");
  return {
    scope,
    base,
    extra,
    window: windowOfViews(p.get("window")),
    filter: {
      who: p.get("who") === "scrapers" ? "scrapers" : "people",
      ...source,
      ...pick("medium"),
      ...pick("campaign"),
      ...pick("landing"),
      ...pick("exit"),
    },
    steps: parseSteps(p.get("steps")),
  };
}

/** This view's address with the given parameters changed; a null removes one. */
function href(q: Query, change: Record<string, string | null>): string {
  const params = new URLSearchParams(q.extra);
  params.set("window", q.window);
  if (q.filter.who === "scrapers") params.set("who", "scrapers");
  for (const d of DIMENSIONS) {
    const v = q.filter[d];
    if (v !== undefined) params.set(d, d === "source" && v === "" ? DIRECT : v);
  }
  if (q.steps.length > 0) params.set("steps", q.steps.join(","));
  for (const [k, v] of Object.entries(change)) v === null ? params.delete(k) : params.set(k, v);
  return `${q.base}?${params}`;
}

const probe = (q: Query, ask: Record<string, string>): string =>
  `${PROBE}?${new URLSearchParams({ scope: q.scope, window: q.window, who: q.filter.who, ...ask })}`;

const figure = (q: Query, n: number, ask: Record<string, string>): Html =>
  html`<a href="${probe(q, ask)}" title="How this was counted">${n}</a>`;

function columns(days: readonly Counted[], label: string): Html {
  const top = Math.max(1, ...days.map((d) => d.visits));
  const step = CHART_W / Math.max(1, days.length);
  const bars = days.map((d, i) => {
    const h = (d.visits / top) * CHART_H;
    return h <= 0 ? "" : `<rect x="${(i * step).toFixed(1)}" y="${(CHART_H - h).toFixed(1)}" width="${Math.max(1, step - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="currentColor" fill-opacity="0.7"><title>${escapeHtml(d.key)}: ${d.visits}</title></rect>`;
  });
  return raw(`<svg viewBox="0 0 ${CHART_W} ${CHART_H}" width="${CHART_W}" height="${CHART_H}" role="img" aria-label="${escapeHtml(label)}">${bars.join("")}</svg>`);
}

function block(title: Html | string, content: Html): Html {
  return html`<section class="settings-block"><h2>${title}</h2>${content}</section>`;
}

function panel(q: Query, title: string, rows: readonly Counted[], dimension: Dimension | null): Html {
  return block(
    title,
    rows.length === 0
      ? html`<p class="muted small">None in the window.</p>`
      : html`<div class="table-scroll">
          <table class="table" data-dense>
            <thead>
              <tr><th scope="col">Value</th><th scope="col" class="num">Visits</th></tr>
            </thead>
            <tbody>
              ${rows.map(
                (r) => html`<tr>
                  <td class="break">${dimension === null
                    ? r.key
                    : html`<a href="${href(q, { [dimension]: r.key })}" title="Narrow every panel to this">${r.key}</a>`}</td>
                  <td class="num">${dimension === null
                    ? figure(q, r.visits, { number: "outbound" })
                    : figure(q, r.visits, { dimension, key: r.key })}</td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`,
  );
}

function filters(q: Query): Html {
  const on = DIMENSIONS.filter((d) => q.filter[d] !== undefined);
  if (on.length === 0) return html``;
  return html`<p class="small mb">
    Narrowed to
    ${on.map((d) => html`<strong>${d}</strong> ${q.filter[d] === "" ? DIRECT : q.filter[d]} <a href="${href(q, { [d]: null })}">(clear)</a> `)}
  </p>`;
}

function path(q: Query, now: number, db: Ctx["app"]["db"]): Html {
  const rows = q.steps.length === 0 ? [] : funnel(db, q.scope, q.window, q.filter, q.steps, now);
  return block(
    "A path to a goal",
    html`<p class="muted small mb">
        Name the steps a visit takes, in order, ending in a goal: a path such as
        <code>/signup</code> (a path also counts its sub-pages) or an outbound
        click such as <code>out:github.com</code>. Other pages may come between.
        Choose a source above to start from it.
      </p>
      <form class="row-fields" method="get" action="${q.base}">
        ${Object.entries({ ...q.extra, window: q.window, ...(q.filter.who === "scrapers" ? { who: "scrapers" } : {}), ...Object.fromEntries(DIMENSIONS.flatMap((d) => (q.filter[d] === undefined ? [] : [[d, q.filter[d] === "" && d === "source" ? DIRECT : q.filter[d]!]]))) }).map(
          ([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`,
        )}
        <input class="input mono" name="steps" value="${q.steps.join(",")}" placeholder="/, /explore, out:github.com" aria-label="Steps, comma separated" />
        ${btn("Follow", { size: "sm", variant: "primary" })}
      </form>
      ${rows.length === 0
        ? null
        : html`<div class="table-scroll mt">
            <table class="table" data-dense>
              <caption class="sr-only">Visits at each step and who dropped off</caption>
              <thead>
                <tr><th scope="col">Step</th><th scope="col" class="num">Visits</th><th scope="col" class="num">Lost</th></tr>
              </thead>
              <tbody>
                ${rows.map(
                  (r, i) => html`<tr>
                    <td class="break">${r.step}</td>
                    <td class="num">${figure(q, r.visits, { steps: q.steps.join(","), number: `funnel_${i}` })}</td>
                    <td class="num">${i === 0 ? "–" : html`${r.lost} (${r.lostShare}%)`}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`}`,
  );
}

function github(db: Ctx["app"]["db"], q: Query, now: number): Html {
  const rows = githubSummary(db, new Date(sinceOf(now, q.window)).toISOString().slice(0, 10));
  if (rows.length === 0)
    return html`<p class="muted small mt">
      GitHub's own traffic is not pulled: set <code>FORGE_GITHUB_TOKEN</code> (a token that may read repository
      traffic) and <code>FORGE_GITHUB_REPOS</code> (<code>owner/name,…</code>) and it is stored daily, since GitHub keeps only 14 days.
    </p>`;
  return block(
    "GitHub",
    html`<div class="table-scroll">
      <table class="table" data-dense>
        <caption class="sr-only">GitHub repository traffic, pulled daily</caption>
        <thead>
          <tr><th scope="col">Repository</th><th scope="col" class="num">Views</th><th scope="col" class="num">Viewers</th><th scope="col" class="num">Clones</th><th scope="col" class="num">Cloners</th><th scope="col">Top referrers, last pull</th></tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) => html`<tr>
              <td class="break">${r.repo}</td>
              <td class="num">${r.views}</td><td class="num">${r.viewers}</td>
              <td class="num">${r.clones}</td><td class="num">${r.cloners}</td>
              <td class="break">${r.error !== null ? `Last pull failed: ${r.error}` : r.referrers.map((x) => `${x.key} ${x.count}`).join(", ") || "none"}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`,
  );
}

export function sourcesBody(ctx: Ctx, q: Query, label: string): Html {
  const db = ctx.app.db;
  const now = Date.now();
  const r = sourcesReport(db, q.scope, q.window, q.filter, now);
  const scraping = q.filter.who === "scrapers";
  const empties = r.people + r.scrapers === 0;
  return html`<div class="mb">
      ${seg(Object.keys(WINDOWS).map((w) => ({ label: `${WINDOWS[w as ViewWindow]} days`, href: href(q, { window: w }), current: w === q.window })))}
      ${seg([
        { label: "People", href: href(q, { who: null }), current: !scraping },
        { label: "Scrapers", href: href(q, { who: "scrapers" }), current: scraping },
      ])}
    </div>
    ${filters(q)}
    ${empties
      ? html`<p class="muted">No visits recorded for ${label} in ${WINDOWS[q.window]} days.</p>`
      : html`${block(
            "Visits",
            html`<dl class="stats">
                <div><dt>${scraping ? "Scraper visits" : "Visits"}</dt><dd>${figure(q, r.visits, { number: scraping ? "scrapers" : "visits" })}</dd></div>
                <div><dt>Pages per visit</dt><dd><a href="${probe(q, { number: "page_views" })}" title="How this was counted">${r.pagesPerVisit}</a></dd></div>
                <div><dt>Page views</dt><dd>${figure(q, r.pageViews, { number: "page_views" })}</dd></div>
                <div><dt>${scraping ? "People, kept apart" : "Scrapers, kept apart"}</dt><dd>${figure(q, scraping ? r.people : r.scrapers, { number: scraping ? "visits" : "scrapers" })}</dd></div>
              </dl>
              <div class="table-scroll muted mt">${columns(r.days, `Visits each day over the last ${WINDOWS[q.window]} days`)}</div>`,
          )}
          ${panel(q, "Source", r.sources, "source")}
          ${panel(q, "Medium (utm_medium)", r.mediums, "medium")}
          ${panel(q, "Campaign (utm_campaign)", r.campaigns, "campaign")}
          ${panel(q, "Landing page", r.landings, "landing")}
          ${panel(q, "Where people left (last page)", r.exits, "exit")}
          ${panel(q, `Outbound clicks to ${outboundNames().join(", ")}`, r.outbound, null)}`}
    ${path(q, now, db)}
    ${q.scope === "forge" ? github(db, q, now) : null}
    <p class="small muted mt">
      <strong>How it was counted.</strong> A visit is one visitor's views on one day: a visitor is a hash of the address and
      browser under a salt that changes daily and is then deleted, so no address or cookie is kept, nobody is followed
      across days, and the 7- or 30-day figures add days up. A visit's source, medium and campaign are those of its first
      page (<code>utm_source</code> wins over the referring site; a referrer from this site is not a source; none is "${DIRECT}").
      Scrapers are told by user agent (crawlers, headless browsers, HTTP libraries, none at all) and counted apart.
      ${q.scope === "forge" ? "Forge pages are filed by their route (/:owner/:name), never by a path that could name a private repository." : null}
    </p>
    <p class="small muted">
      <strong>What it cannot see.</strong> Visitors with scripts off or who ask not to be measured (Do-Not-Track), anyone whose
      browser hides the referrer, pages that do not run the beacon (GitHub's own pages, other people's sites; GitHub's
      figures are pulled in separately above), apps whose <code>beacon.js</code> predates the referrer fields, and an outbound
      click when the browser leaves before it can send. Outbound clicks are reported by the visitor's own browser,
      so anyone can post one that never happened: read them as a hint, not a count. Click a number to see how it was counted.
    </p>`;
}

/** GET /settings/traffic/sources — the forge's view, or `?app=<id>` for any app; admins only. */
export function sourcesPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const asked = ctx.url.searchParams.get("app");
  const record = asked === null ? undefined : getAppById(ctx.app.db, asked);
  if (asked !== null && record === undefined) return notFoundPage(ctx);
  const q = queryOf(ctx.url, record?.id ?? "forge", "/settings/traffic/sources", record === undefined ? {} : { app: record.id });
  const label = record === undefined ? "this forge" : "this app";
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "Sources",
    body: html`<div class="page-head"><h1>Where people come from</h1></div>
      ${settingsLayout(accountSections("traffic", { admin: true }), sourcesBody(ctx, q, label), "Account settings")}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** GET /:owner/:name/settings/app/traffic — one app's view, for those who administer it. */
export function appSourcesPage(ctx: Ctx): Response {
  const repo = timedAdminRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const record = getAppByRepo(ctx.app.db, repo.id);
  if (record === undefined) {
    notePhase(ctx.request, "render", 0);
    return notFoundPage(ctx);
  }
  const q = queryOf(ctx.url, record.id, `/${ctx.params.owner}/${ctx.params.name}/settings/app/traffic`, {});
  const rendering = performance.now();
  const response = settingsPageResponse(ctx, repo, "app", "Where people come from", sourcesBody(ctx, q, "this app"));
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
