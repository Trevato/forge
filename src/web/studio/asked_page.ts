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
import type { Ctx } from "../../http/context.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, empty, listCard, row, seg, time, type Tone } from "../ui.ts";

const WORD: Record<AskedState, { text: string; tone: Tone }> = {
  waiting: { text: "Waiting", tone: "default" },
  building: { text: "Building", tone: "attn" },
  shipped: { text: "Shipped", tone: "success" },
  closed: { text: "Closed", tone: "default" },
};

function pullNote(a: Asked): string {
  const merged = a.pulls.find((p) => p.state === "merged");
  if (merged) return `pull #${merged.number} merged`;
  const open = a.pulls.find((p) => p.state === "open");
  if (open) return `pull #${open.number} open`;
  return a.pulls.length > 0 ? "no pull merged" : "no pull yet";
}

function askedRow(a: Asked): Html {
  const word = WORD[a.state];
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
    // One badge per row: a flagged ask says only that nothing was built
    // (the meta line still names its pull), so a phone keeps the title.
    trail: a.flagged
      ? badge("Nothing built", { tone: "danger" })
      : badge(word.text, { tone: word.tone }),
    titleAttr: a.flagged
      ? `${word.text}, and nothing built in ${STALE_DAYS} days`
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
  const { asked, shipped, unshipped, flagged } = counts;
  const sentence =
    asked === 0
      ? "Nothing asked yet"
      : `${asked} asked · ${shipped} shipped${flagged > 0 ? ` · ${flagged} with nothing built` : ""}`;

  const body = html`<h1 id="asked-sentence">What you asked for</h1>
    <p class="muted">${sentence}</p>
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
