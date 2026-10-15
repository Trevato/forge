/**
 * `/asked`: everything a person asked for, oldest unmet first, and what
 * became of it (`core/asked.ts`). The path: the owner wonders whether something he
 * asked for was heard, opens this from the asks page or the board, and
 * opens the ask. One row per ask, one word per row; a row with nothing built
 * after the stale window says so. `?show=` narrows it, `?repo=owner/name`
 * keeps it to one repository.
 */

import {
  askedCounts,
  askedIn,
  askedRepos,
  isAskedOrder,
  isAskedShow,
  STALE_DAYS,
  type Asked,
  type AskedOrder,
  type AskedShow,
  type AskedState,
} from "../../core/asked.ts";
import {
  flagDays,
  thoughtStream,
  type StreamThought,
  type ThoughtState,
} from "../../core/thought_stream.ts";
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
  timeAgo,
  type Tone,
} from "../ui.ts";
import { homeTabs } from "./home_tabs.ts";

const WORD: Record<AskedState, { text: string; tone: Tone }> = {
  waiting: { text: "Waiting", tone: "default" },
  building: { text: "Building", tone: "attn" },
  shipped: { text: "Shipped", tone: "success" },
  closed: { text: "Closed", tone: "default" },
};

const THOUGHT_WORD: Record<ThoughtState, { text: string; tone: Tone }> = {
  unplaced: { text: "Heard", tone: "default" },
  placed: { text: "Placed", tone: "default" },
  building: { text: "Building", tone: "attn" },
  shipped: { text: "Shipped", tone: "success" },
  superseded: { text: "Superseded", tone: "default" },
};

/** Where a thought went: each issue it touched, linked when the viewer may read it. */
function placedLinks(t: StreamThought): Html {
  const links = t.placed.map((x) =>
    !x.readable
      ? html`${x.action} in a repository you cannot read`
      : x.title === null
      ? html`${x.action} ${x.repo} #${x.number}`
      : html`${x.action} <a href="/${x.repo}/issues/${x.number}">${x.repo} #${x.number}</a>`,
  );
  return links.length === 0
    ? html`${t.reply ?? "the planner has not placed it yet"}`
    : html`${links.map((l, i) => html`${i > 0 ? " · " : ""}${l}`)}`;
}

function thoughtRow(t: StreamThought, days: number): Html {
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
    meta: html`${time(t.receivedAt)} · ${t.source} · ${placedLinks(t)}${t.supersededBy
      ? html` · superseded by “${t.supersededBy.text.slice(0, 80)}” ${time(t.supersededBy.receivedAt)}`
      : null}`,
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

function pullNote(a: Asked): string {
  // The row is one link, so the commits are named here and linked on the ask.
  if (a.doneBy.length > 0)
    return `on main in ${a.doneBy.map((o) => o.slice(0, 7)).join(", ")}, waiting for you to close it`;
  const merged = a.pulls.find((p) => p.state === "merged");
  if (merged) return `pull #${merged.number} merged`;
  const open = a.pulls.find((p) => p.state === "open");
  if (open) return `pull #${open.number} open`;
  return a.pulls.length > 0 ? "no pull merged" : "no pull yet";
}

/**
 * The one badge a row wears. Red is for an old ask with nothing to show.
 * An old ask whose pull is open says that, and how long the pull has been
 * open, which is the next thing a person asks.
 */
function wordFor(a: Asked): { text: string; tone: Tone } {
  if (a.doneBy.length > 0) return { text: "Done on main", tone: "success" };
  if (a.flagged) return { text: "Nothing built", tone: "danger" };
  const open = a.pulls.find((p) => p.state === "open");
  if (a.stale && open !== undefined)
    return {
      text: `Pull open ${timeAgo(open.openedAt).replace(/ ago$/, "")}`,
      tone: "attn",
    };
  return WORD[a.state];
}

function askedRow(a: Asked): Html {
  const word = wordFor(a);
  return row({
    href: `${repoBase(a.repo)}/issues/${a.issue.number}`,
    nav: true,
    title: a.issue.title,
    // What became of it comes first: the line is cut at a phone's width, and
    // what is cut is where and who, which the ask's own page says.
    meta: html`${a.lastCrewAt === null
      ? "crew not on it yet"
      : html`crew ${time(a.lastCrewAt)}`}
    · ${pullNote(a)} · ${a.repo.ownerName}/${a.repo.name} #${a.issue.number} ·
    ${a.askedBy} · ${time(a.askedAt)}`,
    // One badge per row, so a phone keeps the title.
    trail: badge(word.text, { tone: word.tone }),
    titleAttr: a.flagged
      ? `${WORD[a.state].text}, and nothing built in ${STALE_DAYS} days`
      : a.issue.title,
  });
}

/**
 * GET /asked — `?show=unshipped` (the default: nothing merged yet),
 * `flagged` or `all`; oldest first unless `?order=newest`; `?repo=` for one.
 */
export function askedPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const q = ctx.url.searchParams;
  const rawShow = q.get("show");
  const show: AskedShow = isAskedShow(rawShow) ? rawShow : "unshipped";
  const rawOrder = q.get("order");
  const order: AskedOrder = isAskedOrder(rawOrder) ? rawOrder : "oldest";
  const repoSpec = q.get("repo");
  const repos = askedRepos(ctx.app.db, ctx.auth.user, repoSpec);
  const counts = askedCounts(ctx.app.db, repos);
  const listed = askedIn(ctx.app.db, repos, { show, order });
  const href = (s: AskedShow, o: AskedOrder = order) => {
    const parts = [
      s === "unshipped" ? "" : `show=${s}`,
      o === "oldest" ? "" : "order=newest",
      repoSpec ? `repo=${encodeURIComponent(repoSpec)}` : "",
    ].filter(Boolean);
    return `/asked${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
  };
  const stream = thoughtStream(ctx.app.db, ctx.auth.user, { limit: 50 });
  const days = flagDays(ctx.app.db, ctx.auth.user.id);
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
      : `${asked} asked · ${shipped} shipped${flagged > 0 ? ` · ${flagged} with nothing built` : ""}`;

  const body = html`${homeTabs("asked")}
    <h1 id="asked-sentence">What you asked for</h1>
    <p class="muted">${sentence}</p>
    ${thoughts}
    <div class="filters bar mb mt">
      ${seg([
        {
          label: "Not shipped",
          href: href("unshipped"),
          current: show === "unshipped",
          count: unshipped,
        },
        {
          label: "Nothing built",
          href: href("flagged"),
          current: show === "flagged",
          count: flagged,
        },
        {
          label: "All",
          href: href("all"),
          current: show === "all",
          count: asked,
        },
      ])}
      <span class="spacer"></span>
      <a class="small muted" href="${href(show, order === "oldest" ? "newest" : "oldest")}"
        >${order === "oldest" ? "Show newest first" : "Show oldest first"}</a
      >
    </div>
    ${listed.length === 0
      ? empty({
          icon: "issue",
          title: asked === 0 ? "Nothing asked yet" : "Nothing here",
          note:
            asked === 0
              ? "What a person tells the crew shows up here, with what became of it."
              : "Every ask in this view has something built for it.",
        })
      : listCard(listed.map(askedRow))}`;
  return page({ ctx, title: "What you asked for", body });
}
