/**
 * `/asked`: everything a person asked for, oldest unmet first, and what
 * became of it (`core/asked.ts`). The path: the owner wonders whether something
 * they asked for was heard, opens this from the asks page or the board, and
 * opens the ask. One row per ask, one sentence per row: what was asked, then
 * what became of it, each linked to its evidence. `?show=` and `?order=`
 * choose the asks; within them, those that need the owner come first, then
 * those in progress, then what landed, then what was closed with nothing
 * merged. `?repo=owner/name` keeps it to one repository.
 */

import {
  askedCounts,
  askedIn,
  askedRepos,
  askedTier,
  isAskedOrder,
  isAskedShow,
  outcomeText,
  type Asked,
  type AskedOrder,
  type AskedShow,
} from "../../core/asked.ts";
import {
  flagDays,
  thoughtStream,
  type StreamThought,
  type ThoughtState,
} from "../../core/thought_stream.ts";
import { cut, thoughtNotes, whereItWent } from "../../actions/ask_state_words.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import {
  badge,
  empty,
  listCard,
  row,
  seg,
  time,
  userTag,
  type Tone,
} from "../ui.ts";
import { homeTabs } from "./home_tabs.ts";

const THOUGHT_WORD: Record<ThoughtState, { text: string; tone: Tone }> = {
  unplaced: { text: "Heard", tone: "default" },
  placed: { text: "Placed", tone: "default" },
  building: { text: "Building", tone: "attn" },
  shipped: { text: "Shipped", tone: "success" },
  superseded: { text: "Superseded", tone: "default" },
};

/** Where a thought went (`whereItWent`), each issue linked when the viewer may read it. */
function placedLinks(t: StreamThought): Html {
  const parts = whereItWent(t).map((x) =>
    x.href === undefined ? html`${x.lead}${x.text}` : html`${x.lead}<a href="${x.href}">${x.text}</a>`,
  );
  return html`${parts.map((l, i) => html`${i > 0 ? " · " : ""}${l}`)}`;
}

export function thoughtRow(t: StreamThought, days: number): Html {
  const word = t.flagged
    ? { text: "Nothing built", tone: "danger" as Tone }
    : THOUGHT_WORD[t.state];
  return row({
    title: t.text,
    titleAttr: t.flagged
      ? t.placedAt === null
        ? `Not placed ${days} days after it was sent`
        : `Nothing merged ${days} days after it was placed`
      : t.text,
    meta: html`${time(t.receivedAt)} · ${t.source} · ${placedLinks(t)}${thoughtNotes(t).map(
      (n) => html` · ${n.text} ${time(n.at)}`,
    )}`,
    trail: badge(word.text, { tone: word.tone }),
  });
}

/** The first placed issue of the oldest flagged thought: the one next action. */
function oldestFlaggedHref(stream: readonly StreamThought[]): string | null {
  for (let i = stream.length - 1; i >= 0; i--) {
    const t = stream[i]!;
    if (!t.flagged) continue;
    const to = t.placed.find((x) => x.title !== null);
    if (to) return `/${to.repo}/issues/${to.number}`;
  }
  return null;
}

/** The ask, its first 80 characters. */
const asking = (a: Asked): string => cut(a.issue.title, 80);

/**
 * What became of the ask, as the end of its sentence, linked to the pull or
 * issue that says so. Only an ask with nothing built wears red; the rest are
 * green for landed, amber for under way, and plain otherwise.
 */
function outcomeOf(a: Asked): { text: Html; badge: { text: string; tone: Tone } } {
  const base = repoBase(a.repo);
  const issue = `${base}/issues/${a.issue.number}`;
  const pull = (n: number) => html`<a href="${base}/pulls/${n}">#${n}</a>`;
  const flagged: Tone = a.flagged ? "danger" : "default";
  if (a.doneBy.length > 0)
    return {
      text: html`<a href="${issue}">${outcomeText(a)}</a>`,
      badge: { text: "Done on main", tone: "success" },
    };
  const o = a.outcome;
  switch (o.kind) {
    case "landed":
      return { text: html`landed in ${pull(o.pull)} ${time(o.at)}`, badge: { text: "Landed", tone: "success" } };
    case "building":
      return {
        text: o.pull === null
          ? html`${userTag(o.by, { avatar: false, mark: o.byMark })} <a href="${issue}">building</a>`
          : html`${userTag(o.by, { avatar: false, mark: o.byMark })} building in ${pull(o.pull)}`,
        badge: { text: "Building", tone: "attn" },
      };
    case "parked":
      return {
        text: html`<a href="${base}/pulls/${o.pull}">${outcomeText(a)}</a>`,
        badge: { text: a.flagged ? "Nothing built" : "Parked", tone: flagged },
      };
    case "failed":
      return {
        text: html`${userTag(o.by, { avatar: false, mark: o.byMark })} <a href="${issue}">failed</a> ${time(o.at)}`,
        badge: { text: a.flagged ? "Nothing built" : "Failed", tone: flagged },
      };
    case "closed":
      return { text: html`<a href="${issue}">${outcomeText(a)}</a>`, badge: { text: "Closed", tone: "default" } };
    default:
      return {
        text: html`<a href="${issue}">${outcomeText(a)}</a>`,
        badge: { text: a.flagged ? "Nothing built" : "Waiting", tone: flagged },
      };
  }
}

function askedRow(a: Asked): Html {
  const out = outcomeOf(a);
  return row({
    title: html`<a href="${repoBase(a.repo)}/issues/${a.issue.number}">${asking(a)}</a>`,
    titleAttr: a.issue.title,
    meta: html`${out.text} · ${a.repo.ownerName}/${a.repo.name} #${a.issue.number}`,
    trail: badge(out.badge.text, { tone: out.badge.tone }),
  });
}

/**
 * GET /asked — `?show=unshipped` (the default: nothing merged yet),
 * `flagged` or `all`; oldest first unless `?order=newest`; `?repo=` for one.
 * Within the order, asks that need the owner come before those in progress,
 * and those before what landed.
 */
export function askedPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!ctx.auth.user) return signInFirst(ctx);
  const user = ctx.auth.user;
  const q = ctx.url.searchParams;
  const rawShow = q.get("show");
  const show: AskedShow = isAskedShow(rawShow) ? rawShow : "unshipped";
  const rawOrder = q.get("order");
  const order: AskedOrder = isAskedOrder(rawOrder) ? rawOrder : "oldest";
  const repoSpec = q.get("repo");
  const repos = timePhase(ctx.request, "repos", () => askedRepos(ctx.app.db, user, repoSpec));
  const counts = timePhase(ctx.request, "counts", () => askedCounts(ctx.app.db, repos));
  const listed = timePhase(ctx.request, "asks", () => askedIn(ctx.app.db, repos, { show, order }));
  const href = (s: AskedShow, o: AskedOrder = order) => {
    const parts = [
      s === "unshipped" ? "" : `show=${s}`,
      o === "oldest" ? "" : "order=newest",
      repoSpec ? `repo=${encodeURIComponent(repoSpec)}` : "",
    ].filter(Boolean);
    return `/asked${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
  };
  const stream = timePhase(ctx.request, "thoughts", () => thoughtStream(ctx.app.db, user, { limit: 50 }));
  const days = timePhase(ctx.request, "flags", () => flagDays(ctx.app.db, user.id));
  const rendering = performance.now();
  // The sort is stable, so each group keeps the order asked for.
  const rows = [...listed].sort((x, y) => askedTier(x) - askedTier(y));
  const next = oldestFlaggedHref(stream);
  const flaggedThoughts = stream.filter((t) => t.flagged).length;
  const thoughts =
    stream.length === 0
      ? null
      : html`<section id="thoughts" aria-labelledby="thoughts-h">
          <div class="bar mb">
            <h2 id="thoughts-h">Your thoughts</h2>
            <span class="spacer"></span>
            ${next === null
              ? null
              : html`<a class="btn" data-variant="primary" href="${next}"
                  >Open the oldest of ${flaggedThoughts} with nothing built</a
                >`}
          </div>
          ${listCard(stream.map((t) => thoughtRow(t, days)))}
        </section>
        <h2 class="mt">Asked in issues</h2>`;
  const { asked, shipped, unshipped, flagged } = counts;
  const sentence =
    asked === 0
      ? "Nothing asked yet"
      : `${asked} asked · ${shipped} landed${flagged > 0 ? ` · ${flagged} with nothing built` : ""}`;

  const body = html`${homeTabs("asked", unshipped)}
    <h1 id="asked-sentence">What you asked for</h1>
    <p class="muted">${sentence}</p>
    ${thoughts}
    <div class="bar mb mt">
      ${seg([
        { label: "Not shipped", href: href("unshipped"), current: show === "unshipped", count: unshipped },
        { label: "Nothing built", href: href("flagged"), current: show === "flagged", count: flagged },
        { label: "All", href: href("all"), current: show === "all", count: asked },
      ])}
      <span class="spacer"></span>
      <a class="small muted" href="${href(show, order === "oldest" ? "newest" : "oldest")}"
        >${order === "oldest" ? "Show newest first" : "Show oldest first"}</a
      >
    </div>
    ${rows.length === 0
      ? empty({
          icon: "issue",
          title: asked === 0 ? "Nothing asked yet" : "Nothing here",
          note:
            asked === 0
              ? "What a person tells the crew shows up here, with what became of it."
              : "Every ask in this view has something built for it.",
        })
      : listCard(rows.map(askedRow))}`;
  const response = page({ ctx, title: "What you asked for", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
