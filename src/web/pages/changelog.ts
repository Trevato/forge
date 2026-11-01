/**
 * The changelog page: what actually went live, newest first and grouped by
 * day, as `release/landings.ts` reads it (the running commit decides), with
 * what has landed but not yet shipped set apart as on its way. The list is
 * one region the live client swaps when a pull merges or production serves
 * a new commit. Public and server-rendered.
 */

import { notePhase, takeSessionTime, timePhaseAsync } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { readLandings, type Landing, type Landings } from "../../release/landings.ts";
import { liveRegionsJs } from "../client.ts";
import { pageHead } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, card, empty, listCard, row, seg, sha, time } from "../ui.ts";

/** Where the live client looks: a merge lands, or production serves a commit. */
const LIVE = "pull.merged,app.serving";
/** Other repositories offered as filters: more than this is a search, not a chip. */
const FILTERS = 6;

/** The day a landing belongs to, in UTC. */
const dayOf = (at: string): string => at.slice(0, 10);

/** Which repository the reader asked for: "" for this forge's own, "all", or one named in the list; anything else is the default. */
export function chosenRepo(asked: string | null, all: readonly Landing[], own: string | undefined): string {
  if (asked === "all") return "all";
  if (asked !== null && all.some((l) => l.repo === asked)) return asked;
  return own === undefined ? "all" : own;
}

function landingRow(l: Landing, own: string | undefined, showRepo: boolean): Html {
  return row({
    href: `/${l.repo}/pulls/${l.number}`,
    title: l.title,
    meta: html`${showRepo || l.repo !== own ? html`${l.repo} · ` : null}#${l.number}`,
    trail: time(l.at),
  });
}

function byDay(list: readonly Landing[], own: string | undefined, showRepo: boolean): Html[] {
  const days = new Map<string, Landing[]>();
  for (const l of list) days.set(dayOf(l.at), [...(days.get(dayOf(l.at)) ?? []), l]);
  return [...days].map(([day, items]) =>
    card(html`<ul class="list">${items.map((l) => landingRow(l, own, showRepo))}</ul>`, {
      head: html`<h2><time datetime="${day}">${day}</time></h2>${badge(String(items.length))}`,
      pad: false,
    }),
  );
}

/** The region: the top line, what is on its way, and what went live by day. */
export function shippedRegion(read: Landings, choice: string, now: Date = new Date()): Html {
  const keep = (l: Landing) => choice === "all" || l.repo === choice;
  const live = read.live.filter(keep);
  const onItsWay = read.onItsWay.filter(keep);
  const today = live.filter((l) => dayOf(l.at) === now.toISOString().slice(0, 10)).length;
  const version = read.commit === null ? read.version : html`${read.version} · ${sha(read.commit)}`;
  const top = html`<p class="small muted" id="shipped-top">
    Live: ${version}. ${today === 0 ? "Nothing shipped today." : `${today} shipped today.`}
  </p>`;
  const way =
    onItsWay.length === 0
      ? null
      : html`<h2 class="mt">On its way</h2>${listCard(onItsWay.map((l) => landingRow(l, read.own, choice === "all")))}`;
  const gone =
    live.length === 0
      ? empty({ title: "Nothing has shipped yet", note: "Each pull appears here once the running commit contains it." })
      : html`${byDay(live, read.own, choice === "all")}`;
  return html`${top}${way}${gone}`;
}

// GET /changelog?repo=all|owner/name
export async function changelogPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const read = await timePhaseAsync(ctx.request, "releases", () => readLandings(ctx.app));
  const rendering = performance.now();
  const everything = [...read.onItsWay, ...read.live];
  const choice = chosenRepo(new URL(ctx.request.url).searchParams.get("repo"), everything, read.own);
  const others = [...new Set(everything.map((l) => l.repo))].filter((r) => r !== read.own).slice(0, FILTERS);
  const filters = seg([
    ...(read.own === undefined ? [] : [{ label: "This forge", href: "/changelog", current: choice === read.own }]),
    { label: "Everything", href: "/changelog?repo=all", current: choice === "all" },
    ...others.map((r) => ({ label: r, href: `/changelog?repo=${encodeURIComponent(r)}`, current: choice === r })),
  ]);
  const body = html`${pageHead("Changelog", { sub: "What went live, as it happens." })}${filters}
    <div id="shipped" data-live="${LIVE}" aria-live="polite">${shippedRegion(read, choice)}</div>`;
  const response = page({ ctx, title: "Changelog", body, scriptJs: liveRegionsJs });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
