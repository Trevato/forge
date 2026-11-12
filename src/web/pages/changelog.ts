/**
 * The changelog page: what actually went live, newest first and grouped by
 * day, as `release/landings.ts` reads it (the running commit decides), with
 * what has landed but not yet shipped set apart as on its way. The list is
 * one region the live client swaps when a pull merges or production serves
 * a new commit. Public and server-rendered.
 */

import { notePhase, takeSessionTime, timePhaseAsync } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { betNamesOfPulls } from "../../core/bets.ts";
import { sourcesOfPulls } from "../../core/trusted_sources.ts";
import { canRead, getRepo, type Repo } from "../../core/repos.ts";
import { newestLive, secondsWords } from "../../keeper/landed.ts";
import { dayHeading, dayOf, daysJs, shippedToday } from "../../release/days.ts";
import { chosenRepo, readLandings, type Landing, type Landings } from "../../release/landings.ts";
import { gather, plainTitle, type Gathered } from "../../story/gather.ts";
import { milestoneHref, progress } from "./milestones.ts";
import { nearMilestones, nearWords, type Near } from "./milestones_near.ts";
import { liveRegionsJs } from "../client.ts";
import { pageHead, repoBase } from "../chrome.ts";
import { changelogTag, holds } from "../feeds.ts";
import { EDGE_FRESH, EDGE_STALE, EDGE_VARY } from "../../http/edge_cache.ts";
import { json, securityFloor } from "../../http/respond.ts";
import { readFlash } from "../flash.ts";
import { shippedAnswer } from "../../release/answer.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, row, seg, sha, time, timeAgo } from "../ui.ts";

/** Where the live client looks: a merge lands, or production serves a commit. */
const LIVE = "pull.merged,app.serving";
/** How close each open milestone is, above the waves: absent when there are none. */
function nearBlock(base: string, near: readonly Near[]): Html | null {
  if (near.length === 0) return null;
  return html`<ul class="list setting-list" id="milestones-near" aria-label="Open milestones">${near.map((m) =>
    row({
      nav: true,
      title: html`<a href="${milestoneHref(base, m.number)}">${m.name}</a>`,
      meta: progress(m.done, m.total, `${m.name}: ${m.done} of ${m.total} done`),
      trail: html`${nearWords(m)}`,
    }),
  )}</ul>`;
}

/** Other repositories offered as filters: more than this is a search, not a chip. */
const FILTERS = 6;

function landingRow(l: Landing, own: string | undefined, showRepo: boolean): Html {
  return row({
    href: `/${l.repo}/pulls/${l.number}`,
    nav: true,
    title: plainTitle(l.title),
    meta: html`${showRepo || l.repo !== own ? html`${l.repo} · ` : null}#${l.number}${l.bet === undefined ? null : html` · ${badge(l.bet, { variant: "outline" })}`}${l.from === undefined ? null : html` · folded in from ${l.from}`}`,
    facts: [...(l.by === undefined ? [] : [{ label: "By", value: l.by }]), ...(l.with === undefined ? [] : [{ label: "With", value: l.with.join(", ") }])],
    trail: time(l.at),
  });
}

/** Several landings of one shape as one line, opening in place to each pull; who built them is said once. */
function gatheredRow(g: Gathered<Landing>, own: string | undefined, showRepo: boolean, day: string): Html {
  const first = g.landings[0]!;
  const credit = [...(g.by.length === 0 ? [] : [g.by.join(", ")]), ...(g.with.length === 0 ? [] : [`with ${g.with.join(", ")}`])].join(" · ");
  const quiet = g.landings.map(({ by: _by, with: _with, ...l }): Landing => l);
  return row({
    title: g.shape,
    meta: html`${g.landings.length} pulls${credit === "" ? null : html` · ${credit}`}`,
    trail: time(first.at),
    data: { count: String(g.landings.length) },
    fold: { open: false, id: `gathered-${day}-${first.repo.replace(/[^a-z0-9]+/gi, "-")}-${first.number}`, body: html`<ul class="row-children list setting-list">${quiet.map((l) => landingRow(l, own, showRepo))}</ul>` },
  });
}

/** Day sections in `zone`; the browser regroups them in its own (see `localDaysJs`), so the zone is named while it has not. */
function byDay(list: readonly Landing[], own: string | undefined, showRepo: boolean, zone: string, today: string): Html[] {
  const days = new Map<string, Landing[]>();
  for (const l of list) days.set(dayOf(l.at, zone), [...(days.get(dayOf(l.at, zone)) ?? []), l]);
  return [...days].map(([day, items]) =>
    html`<section class="mt" data-day="${day}"><h2><time datetime="${day}">${dayHeading(day, today)}</time>${zone === "UTC" ? html` <span data-zone>${badge("UTC", { variant: "outline" })}</span>` : null} ${badge(String(items.length))}</h2><ul class="list setting-list">${gather(items).map((g) => (g.landings.length === 1 ? landingRow(g.landings[0]!, own, showRepo) : gatheredRow(g, own, showRepo, day)))}</ul></section>`,
  );
}

/**
 * Moves the changelog's rows into the reader's own days: headings, the
 * "shipped today" count and the UTC mark follow the browser's time zone.
 * Without script the server's UTC grouping stands, and says so.
 */
export const localDaysJs = /* js */ `
(function () {
  ${daysJs}
  function regroup() {
    var root = document.getElementById('shipped');
    if (!root) return;
    var cards = root.querySelectorAll('[data-day]');
    var top = document.getElementById('shipped-today');
    if (!cards.length && !top) return;
    var today = dayOf(new Date().toISOString());
    var rows = [];
    cards.forEach(function (c) { c.querySelectorAll(':scope > ul > li').forEach(function (li) { rows.push(li); }); });
    var seen = {}, order = [];
    rows.forEach(function (li) {
      var t = li.querySelector('time[datetime]');
      var d = t ? dayOf(t.getAttribute('datetime')) : '';
      li.setAttribute('data-local-day', d);
      if (!seen[d]) { seen[d] = []; order.push(d); }
      seen[d].push(li);
    });
    function count(list) { return list.reduce(function (n, li) { return n + (Number(li.getAttribute('data-count')) || 1); }, 0); }
    if (cards.length) {
      var proto = cards[0];
      var after = proto.previousSibling;
      var parent = proto.parentNode;
      var made = order.map(function (d) {
        var c = proto.cloneNode(true);
        c.setAttribute('data-day', d);
        var tm = c.querySelector('h2 time');
        tm.setAttribute('datetime', d);
        tm.textContent = dayHeading(d, today);
        var z = c.querySelector('[data-zone]');
        if (z) z.parentNode.removeChild(z);
        var ul = c.querySelector('ul');
        while (ul.firstChild) ul.removeChild(ul.firstChild);
        seen[d].forEach(function (li) { ul.appendChild(li); });
        var n = c.querySelector('.badge');
        if (n) n.textContent = String(count(seen[d]));
        return c;
      });
      cards.forEach(function (c) { parent.removeChild(c); });
      var ref = after ? after.nextSibling : parent.firstChild;
      made.forEach(function (c) { parent.insertBefore(c, ref); });
    }
    // An empty #shipped-today with no cards is the server saying nothing has ever shipped:
    // writing the count here would bring back the second empty state.
    if (top && (cards.length || top.textContent)) {
      var n = count(seen[today] || []);
      top.textContent = shippedToday(n, false);
    }
  }
  regroup();
  document.addEventListener('forge:swapped', regroup);
})();
`;

/** Rendered regions kept by what they were rendered from; a few views (repo filters) are in use at once. */
const REGIONS = 8;
const rendered = new Map<string, Html>();

/**
 * The region, kept per input: the same landings, view, day and minute (rows
 * speak in "5m ago") render the same markup, and 500 rows cost ~50 ms to build.
 */
export function shippedRegion(
  read: Landings,
  choice: string,
  now: Date = new Date(),
  zone = "UTC",
  toLive?: { version: string; seconds: number },
  readable = true,
): Html {
  const key = `${Bun.hash(JSON.stringify([read, choice, zone, toLive ?? null, readable])).toString(36)}:${Math.floor(now.getTime() / 60_000)}`;
  const kept = rendered.get(key);
  if (kept !== undefined) return kept;
  const made = renderRegion(read, choice, now, zone, toLive, readable);
  if (rendered.size >= REGIONS) rendered.delete(rendered.keys().next().value as string);
  rendered.set(key, made);
  return made;
}

/** The region: the top line, what is on its way, and what went live by day. */
function renderRegion(
  read: Landings,
  choice: string,
  now: Date = new Date(),
  zone = "UTC",
  toLive?: { version: string; seconds: number },
  readable = true,
): Html {
  const keep = (l: Landing) => choice === "all" || l.repo === choice;
  const live = read.live.filter(keep);
  const onItsWay = read.onItsWay.filter(keep);
  const todayIs = dayOf(now.toISOString(), zone);
  const today = live.filter((l) => dayOf(l.at, zone) === todayIs).length;
  // The short sha is a way in to the commit's page, unless there is no repository or the reader may not open it.
  const commit =
    read.commit === null ? null : sha(read.commit, readable && read.own !== undefined ? `/${read.own}/commit/${read.commit}` : undefined);
  // A build that is not a release has no version worth a reader's attention: the commit says it.
  const version =
    read.version !== "dev" ? (commit === null ? read.version : html`${read.version} · ${commit}`) : (commit ?? "a development build");
  const top = html`<p class="small muted" id="shipped-top">
    Live: ${version}.${toLive !== undefined && toLive.version === read.version ? html` Landed to live in ${secondsWords(toLive.seconds)}.` : null} <span id="shipped-today">${live.length === 0 ? "" : shippedToday(today, zone === "UTC")}</span>
  </p>`;
  const way =
    onItsWay.length === 0
      ? null
      : html`<h2 class="mt">On its way</h2><ul class="list setting-list">${onItsWay.map((l) => landingRow(l, read.own, choice === "all"))}</ul>`;
  const gone =
    live.length === 0
      ? html`<p class="mt muted">Nothing has shipped yet.</p>`
      : html`${byDay(live, read.own, choice === "all", zone, todayIs)}`;
  return html`${top}${way}${gone}`;
}

// GET /changelog?repo=all|owner/name
export async function changelogPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const landed = await timePhaseAsync(ctx.request, "releases", () => readLandings(ctx.app));
  const ownRepo = landed.own === undefined ? undefined : getRepo(ctx.app.db, ...(landed.own.split("/") as [string, string]));
  const readable = ownRepo !== undefined && canRead(ctx.app.db, ownRepo, ctx.auth.user);
  const { read, bets, bet } = withBets(ctx, landed, readable ? ownRepo : undefined);
  // The forge's own repository, even before anything has landed in it.
  const planned = nearMilestones(ctx.app, landed.own ?? ctx.app.config.forgeRepo, ctx.auth.user);
  const near = planned?.near ?? [];
  const everything = [...read.onItsWay, ...read.live];
  const choice = chosenRepo(new URL(ctx.request.url).searchParams.get("repo"), everything, read.own);
  const others = [...new Set(everything.map((l) => l.repo))].filter((r) => r !== read.own).slice(0, FILTERS);
  // The tag comes from what the page would say, before any of it is rendered:
  // a match answers 304 without building the page.
  const toLive = newestLive(ctx.app.db);
  const flashed = readFlash(ctx.request) !== undefined;
  const tag = flashed ? undefined : changelogTag(read.version, everything, [choice, bet, read.commit, read.live.map((l) => `${l.repo}#${l.number}`), readable, toLive ?? null, everything.map((l) => timeAgo(l.at)), new Date().toISOString().slice(0, 10), ctx.auth.user?.id ?? null, ctx.auth.user?.isAdmin === true, ctx.theme ?? null, near]);
  const keep = tag === undefined ? undefined : cacheHeaders(ctx, tag);
  if (keep !== undefined && keep.matched) return keep.response;
  const rendering = performance.now();
  const filters = seg([
    ...(read.own === undefined ? [] : [{ label: "This forge", href: "/changelog", current: choice === read.own }]),
    { label: "Everything", href: "/changelog?repo=all", current: choice === "all" },
    ...others.map((r) => ({ label: r, href: `/changelog?repo=${encodeURIComponent(r)}`, current: choice === r })),
  ]);
  const betFilters =
    bets.length === 0 || choice !== read.own
      ? null
      : seg([
          { label: "Every bet", href: "/changelog", current: bet === "" },
          ...bets.map((b) => ({ label: b, href: `/changelog?bet=${encodeURIComponent(b)}`, current: bet === b })),
        ]);
  const body = html`${pageHead("Changelog", { sub: "What went live, as it happens." })}${nearBlock(planned === undefined ? "" : repoBase(planned.repo), near)}${filters}${betFilters}${read.own !== undefined && readable ? html`<p class="small"><a href="/${read.own}/waves" data-waves-link>Read it by wave</a></p>` : null}
    <div id="shipped" data-live="${LIVE}" aria-live="polite">${shippedRegion(read, choice, new Date(), "UTC", toLive, readable)}</div>`;
  const response = page({ ctx, title: "Changelog", body, feed: { href: "/changelog.atom", title: "Changelog" }, json: { href: `/api/v1/changelog${choice === read.own ? "" : `?repo=${encodeURIComponent(choice)}`}`, title: "Changelog (JSON)" }, scriptJs: `${liveRegionsJs}\n${localDaysJs}` });
  notePhase(ctx.request, "render", performance.now() - rendering);
  if (keep === undefined) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of keep.headers) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * What a tagged answer says about caching, and whether the reader already
 * holds it. The tag is of what the page shows (release, rows, filter, each
 * row's "5m ago" wording, who reads), so it dies when the page would change
 * and not before. A match is a 304 without rendering. Only a request carrying
 * no identity at all may be kept by a shared cache; any other answer is
 * `private`. A page that shows a flash is never tagged (the caller skips it).
 */
function cacheHeaders(ctx: Ctx, etag: string): { matched: boolean; response: Response; headers: Headers } | undefined {
  if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") return undefined;
  const h = ctx.request.headers;
  const anonymous = !h.has("cookie") && !h.has("authorization") && !h.has("x-plat-user") && !h.has("x-plat-edge-token") && ctx.auth.user === undefined;
  const headers = new Headers({ etag });
  if (anonymous) {
    headers.set("cache-control", `public, max-age=0, s-maxage=${EDGE_FRESH}, stale-while-revalidate=${EDGE_STALE}`);
    headers.set("vary", EDGE_VARY);
  } else headers.set("cache-control", "private, no-cache");
  const matched = holds(h.get("if-none-match"), etag);
  // The 304 carries the floor headers; the stored copy keeps the CSP it came with.
  const response = matched ? securityFloor(new Response(null, { status: 304, headers: new Headers(headers) })) : new Response(null);
  return { matched, response, headers };
}

// GET /api/v1/changelog?repo=all|owner/name: the page's rows as JSON, public repositories only.
export async function changelogJson(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const asked = ctx.url.searchParams.get("repo");
  const answer = await shippedAnswer(ctx.app, asked);
  // The answer is the same for every viewer (public repositories only), so a shared cache may keep it.
  const etag = changelogTag(answer.version, [...answer.live, ...answer.onItsWay], [asked ?? "", answer.live.length]);
  const headers = { etag, "cache-control": "public, max-age=5" };
  if (holds(ctx.request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return json(answer, 200, headers);
}

/**
 * The landings with the bet each built (#8713), and `?bet=` narrowing them to
 * one bet's. Only the forge's own repository, and only for a reader of it.
 */
function withBets(ctx: Ctx, read: Landings, repo: Repo | undefined): { read: Landings; bets: string[]; bet: string } {
  if (repo === undefined) return { read, bets: [], bet: "" };
  const numbers = [...read.live, ...read.onItsWay].filter((l) => l.repo === read.own).map((l) => l.number);
  const names = betNamesOfPulls(ctx.app.db, repo.id, numbers);
  const froms = sourcesOfPulls(ctx.app.db, repo.id, numbers);
  const mark = (l: Landing): Landing => {
    if (l.repo !== read.own) return l;
    const bet = names.get(l.number);
    const from = froms.get(l.number);
    return { ...l, ...(bet === undefined ? {} : { bet }), ...(from === undefined ? {} : { from }) };
  };
  const live = read.live.map(mark);
  const onItsWay = read.onItsWay.map(mark);
  const bets = [...new Set([...live, ...onItsWay].flatMap((l) => (l.bet === undefined ? [] : [l.bet])))].sort();
  const asked = ctx.url.searchParams.get("bet") ?? "";
  const bet = bets.includes(asked) ? asked : "";
  const keep = (l: Landing) => bet === "" || l.bet === bet;
  return { read: { ...read, live: live.filter(keep), onItsWay: onItsWay.filter(keep) }, bets, bet };
}
