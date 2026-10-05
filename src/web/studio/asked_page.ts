/**
 * `/asked`: everything a person asked for, newest first, and what became of
 * it (`core/asked.ts`). The path: the owner wonders whether something he
 * asked for was heard, opens this from the asks page or the board, and
 * opens the ask. One row per ask, one word per row; a row with nothing built
 * after the stale window says so. `?show=` narrows it, `?repo=owner/name`
 * keeps it to one repository.
 */

import {
  askedIn,
  askedRepos,
  isAskedShow,
  STALE_DAYS,
  type Asked,
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

const shows = (a: Asked, show: AskedShow): boolean =>
  show === "all" ||
  (show === "flagged"
    ? a.flagged
    : a.state === "waiting" || a.state === "building");

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
    meta: html`${a.repo.ownerName}/${a.repo.name} #${a.issue.number} ·
    ${a.askedBy} · ${time(a.askedAt)} · ${pullNote(a)}`,
    trail: html`${a.flagged
      ? badge(`Nothing built in ${STALE_DAYS} days`, { tone: "danger" })
      : null}
    ${badge(word.text, { tone: word.tone })}`,
  });
}

export function askedPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const raw = ctx.url.searchParams.get("show");
  const show: AskedShow = isAskedShow(raw) ? raw : "all";
  const repoSpec = ctx.url.searchParams.get("repo");
  const all = askedIn(ctx.app.db, askedRepos(ctx.app.db, ctx.auth.user, repoSpec));
  const listed = all.filter((a) => shows(a, show));
  const count = (s: AskedShow) => all.filter((a) => shows(a, s)).length;
  const keep = repoSpec ? `repo=${encodeURIComponent(repoSpec)}` : "";
  const href = (s: AskedShow) => {
    const q = [s === "all" ? "" : `show=${s}`, keep].filter(Boolean).join("&");
    return `/asked${q ? `?${q}` : ""}`;
  };
  const shipped = all.filter((a) => a.state === "shipped").length;
  const flagged = count("flagged");
  const sentence =
    all.length === 0
      ? "Nothing asked yet"
      : `${all.length} asked · ${shipped} shipped${flagged > 0 ? ` · ${flagged} with nothing built` : ""}`;

  const body = html`<h1 id="asked-sentence">What you asked for</h1>
    <p class="muted">${sentence}</p>
    <div class="filters mb mt">
      ${seg([
        {
          label: "All",
          href: href("all"),
          current: show === "all",
          count: all.length,
        },
        {
          label: "Not shipped",
          href: href("unshipped"),
          current: show === "unshipped",
          count: count("unshipped"),
        },
        {
          label: "Nothing built",
          href: href("flagged"),
          current: show === "flagged",
          count: flagged,
        },
      ])}
    </div>
    ${listed.length === 0
      ? empty({
          icon: "issue",
          title: all.length === 0 ? "Nothing asked yet" : "Nothing here",
          note:
            all.length === 0
              ? "What a person tells the crew shows up here, with what became of it."
              : "Every ask in this view has something built for it.",
        })
      : listCard(listed.map(askedRow))}`;
  return page({ ctx, title: "What you asked for", body });
}
