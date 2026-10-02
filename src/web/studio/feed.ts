/**
 * The home's feed: the ranked read model (`feed/feed.ts`) as cards. Each card
 * is one sentence of why, a link straight into the thing, a way to say
 * something to the crew from where you are, and dismiss / mute. The first
 * page is server-rendered; the same region answers at `/live/feed` so a
 * forge event refreshes it through the live-regions client, like the shelf.
 * Every string on a card is plain text and is escaped here, once.
 */

import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { readFeed } from "../../feed/feed.ts";
import type { FeedItem } from "../../feed/rank.ts";
import { html, type Html } from "../html.ts";
import { fragment } from "../layout.ts";
import { btn, empty } from "../ui.ts";

/** Events that can change what the feed says. */
export const FEED_LIVE =
  "run.finished,pull.opened,pull.merged,pull.reviewed,pull.closed,look.taken,app.serving,issue.blocked,issue.unblocked,decision.*";

export const FEED_FIRST_PAGE = 20;

const RUN_LINK = /^\/[^/]+\/[^/]+\/runs\/[A-Za-z0-9_-]+$/;

const KIND_LABEL: Record<FeedItem["kind"], string> = {
  run: "Run",
  ask: "Needs you",
  pull: "Change",
  decision: "Decision",
  map: "Map",
  cost: "Cost",
};

/** One card. A run's card steers the run; every card can tell its app. */
export function feedCard(item: FeedItem): Html {
  const steer = item.kind === "run" || item.kind === "cost";
  const target = steer && RUN_LINK.test(item.link) ? `${item.link}/steer` : null;
  return html`<article
    class="fcard"
    data-nav
    tabindex="0"
    data-item="${item.id}"
    data-app="${item.app}"
    data-kind="${item.kind}"
  >
    <div class="fcard-head">
      <span class="badge">${KIND_LABEL[item.kind]}</span>
      <span class="fcard-app muted small">${item.app}</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm btn-ghost" data-feed="dismissed" title="Dismiss (x)">Dismiss</button>
      <button type="button" class="btn btn-sm btn-ghost" data-feed="muted" title="Mute ${item.app}">Mute app</button>
    </div>
    <p class="fcard-reason"><a href="${item.link}" data-feed-open>${item.reason}</a></p>
    <details class="fcard-say">
      <summary class="small">${target ? "Steer" : "Tell the crew"}</summary>
      <form method="post" action="${target ?? `/${item.app}/tell`}" class="fcard-form">
        <textarea name="text" rows="2" maxlength="2000" required aria-label="${target ? "Steer this run" : "Tell the crew"}"></textarea>
        ${btn(target ? "Steer" : "Tell", { size: "sm", variant: "primary" })}
      </form>
    </details>
  </article>`;
}

/** The region: cards, or one line saying there is nothing to do. */
export function feedRegion(user: User, ctx: Ctx): Html {
  const { items } = readFeed(ctx.app.db, user, { limit: FEED_FIRST_PAGE });
  return html`<section
    id="live-feed"
    class="feed"
    aria-label="Feed"
    data-live="${FEED_LIVE}"
    data-live-src="/live/feed"
  >
    ${items.length === 0
      ? empty({
          icon: "activity",
          title: "Nothing new",
          note: "When something happens in your apps, it lands here.",
        })
      : items.map(feedCard)}
  </section>`;
}

// GET /live/feed — the feed alone, for the region that shows it.
export function liveFeedFragment(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return fragment(html``, { status: 404 });
  return fragment(feedRegion(user, ctx), { request: ctx.request });
}

/**
 * j/k and enter are the shell's (`data-nav`). Here: `x` dismisses the card
 * in focus, the buttons dismiss or mute, and opening a card is recorded.
 * Interactions go to the feed API, same-origin with the session cookie.
 */
export const feedJs = /* js */ `
(function () {
  var feed = document.getElementById('live-feed');
  if (!feed || typeof fetch === 'undefined') return;
  function send(card, kind, keepalive) {
    var body = { item: card.getAttribute('data-item'), kind: kind, app: card.getAttribute('data-app') };
    return fetch('/api/v1/feed/interactions', {
      method: 'POST', credentials: 'same-origin', keepalive: !!keepalive,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
  }
  function gone(card) {
    var cards = Array.prototype.slice.call(feed.querySelectorAll('.fcard'));
    var next = cards[cards.indexOf(card) + 1] || cards[cards.indexOf(card) - 1];
    card.hidden = true;
    if (next) next.focus();
  }
  function act(card, kind) {
    send(card, kind).then(function (r) { if (r.ok) gone(card); }, function () {});
  }
  feed.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-feed],[data-feed-open]') : null;
    var card = t && t.closest('.fcard');
    if (!card) return;
    if (t.hasAttribute('data-feed-open')) { send(card, 'opened', true).catch(function () {}); return; }
    act(card, t.getAttribute('data-feed'));
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'x' || e.metaKey || e.ctrlKey || e.altKey) return;
    var a = document.activeElement;
    if (!a || !a.matches || !a.matches('.fcard')) return;
    e.preventDefault();
    act(a, 'dismissed');
  });
})();
`;
