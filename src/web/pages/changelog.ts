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
import { liveRegionsJs } from "../client.ts";
import { pageHead } from "../chrome.ts";
import { json } from "../../http/respond.ts";
import { shippedAnswer } from "../../release/answer.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, card, empty, listCard, row, seg, sha, time } from "../ui.ts";

/** Where the live client looks: a merge lands, or production serves a commit. */
const LIVE = "pull.merged,app.serving";
/** Other repositories offered as filters: more than this is a search, not a chip. */
const FILTERS = 6;

function landingRow(l: Landing, own: string | undefined, showRepo: boolean): Html {
  return row({
    href: `/${l.repo}/pulls/${l.number}`,
    title: l.title,
    meta: html`${showRepo || l.repo !== own ? html`${l.repo} · ` : null}#${l.number}${l.bet === undefined ? null : html` · ${badge(l.bet, { variant: "outline" })}`}${l.from === undefined ? null : html` · folded in from ${l.from}`}`,
    trail: time(l.at),
  });
}

/** Day cards in `zone`; the browser regroups them in its own (see `localDaysJs`), so the zone is named while it has not. */
function byDay(list: readonly Landing[], own: string | undefined, showRepo: boolean, zone: string, today: string): Html[] {
  const days = new Map<string, Landing[]>();
  for (const l of list) days.set(dayOf(l.at, zone), [...(days.get(dayOf(l.at, zone)) ?? []), l]);
  return [...days].map(([day, items]) =>
    card(html`<ul class="list">${items.map((l) => landingRow(l, own, showRepo))}</ul>`, {
      head: html`<h2><time datetime="${day}">${dayHeading(day, today)}</time>${zone === "UTC" ? html`<span data-zone>${badge("UTC", { variant: "outline" })}</span>` : null}</h2>${badge(String(items.length))}`,
      attrs: html`data-day="${day}"`,
      pad: false,
    }),
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
    cards.forEach(function (c) { c.querySelectorAll('li').forEach(function (li) { rows.push(li); }); });
    var seen = {}, order = [];
    rows.forEach(function (li) {
      var t = li.querySelector('time[datetime]');
      var d = t ? dayOf(t.getAttribute('datetime')) : '';
      li.setAttribute('data-local-day', d);
      if (!seen[d]) { seen[d] = []; order.push(d); }
      seen[d].push(li);
    });
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
        if (n) n.textContent = String(seen[d].length);
        return c;
      });
      cards.forEach(function (c) { parent.removeChild(c); });
      var ref = after ? after.nextSibling : parent.firstChild;
      made.forEach(function (c) { parent.insertBefore(c, ref); });
    }
    // An empty #shipped-today with no cards is the server saying nothing has ever shipped:
    // writing the count here would bring back the second empty state.
    if (top && (cards.length || top.textContent)) {
      var n = (seen[today] || []).length;
      top.textContent = shippedToday(n, false);
    }
  }
  regroup();
  document.addEventListener('forge:swapped', regroup);
})();
`;

/** The region: the top line, what is on its way, and what went live by day. */
export function shippedRegion(
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
      : html`<h2 class="mt">On its way</h2>${listCard(onItsWay.map((l) => landingRow(l, read.own, choice === "all")))}`;
  const gone =
    live.length === 0
      ? empty({ title: "Nothing has shipped yet", note: "Each pull appears here once the running commit contains it." })
      : html`${byDay(live, read.own, choice === "all", zone, todayIs)}`;
  return html`${top}${way}${gone}`;
}

// GET /changelog?repo=all|owner/name
export async function changelogPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const landed = await timePhaseAsync(ctx.request, "releases", () => readLandings(ctx.app));
  const rendering = performance.now();
  const ownRepo = landed.own === undefined ? undefined : getRepo(ctx.app.db, ...(landed.own.split("/") as [string, string]));
  const readable = ownRepo !== undefined && canRead(ctx.app.db, ownRepo, ctx.auth.user);
  const { read, bets, bet } = withBets(ctx, landed, readable ? ownRepo : undefined);
  const everything = [...read.onItsWay, ...read.live];
  const choice = chosenRepo(new URL(ctx.request.url).searchParams.get("repo"), everything, read.own);
  const others = [...new Set(everything.map((l) => l.repo))].filter((r) => r !== read.own).slice(0, FILTERS);
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
  const body = html`${pageHead("Changelog", { sub: "What went live, as it happens." })}${filters}${betFilters}
    <div id="shipped" data-live="${LIVE}" aria-live="polite">${shippedRegion(read, choice, new Date(), "UTC", newestLive(ctx.app.db), readable)}</div>`;
  const response = page({ ctx, title: "Changelog", body, feed: { href: "/changelog.atom", title: "Changelog" }, json: { href: `/api/v1/changelog${choice === read.own ? "" : `?repo=${encodeURIComponent(choice)}`}`, title: "Changelog (JSON)" }, scriptJs: `${liveRegionsJs}\n${localDaysJs}` });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// GET /api/v1/changelog?repo=all|owner/name: the page's rows as JSON, public repositories only.
export async function changelogJson(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return json(await shippedAnswer(ctx.app, ctx.url.searchParams.get("repo")), 200, { "cache-control": "public, max-age=5" });
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
