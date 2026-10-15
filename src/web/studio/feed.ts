/**
 * The home's feed: the ranked read model (`feed/feed.ts`) as posts (#599).
 * Each post is who did it, what it says in its own words as a link straight
 * into the thing, a small line of why it is here, a way to say something to
 * the crew from where you are, and dismiss / mute. Above them, the composer. The first
 * page is server-rendered; the same region answers at `/live/feed` so a
 * forge event refreshes it through the live-regions client, like the shelf.
 * Every string on a card is plain text and is escaped here, once.
 */

import { marksByName, type Mark } from "../../core/marks.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { recentThoughts, type Thought } from "../../core/thoughts.ts";
import { readFeed } from "../../feed/feed.ts";
import type { FeedItem } from "../../feed/rank.ts";
import { html, type Html } from "../html.ts";
import { fragment } from "../layout.ts";
import { outboxJs } from "../outbox.ts";
import { avatar, btn, empty, nameMark, timeAgo } from "../ui.ts";
import { writableAppsOf } from "./asks.ts";

/** Events that can change what the feed says. */
export const FEED_LIVE =
  "run.finished,issue.opened,issue.commented,pull.commented,pull.opened,pull.merged,pull.reviewed,pull.closed,look.taken,app.serving,issue.blocked,issue.unblocked,issue.closed,decision.*,thought.received";

export const FEED_FIRST_PAGE = 20;

const RUN_LINK = /^\/[^/]+\/[^/]+\/runs\/[A-Za-z0-9_-]+$/;

const KIND_LABEL: Record<FeedItem["kind"], string> = {
  run: "Run",
  ask: "Needs you",
  pull: "Change",
  decision: "Decision",
  map: "Map",
  cost: "Cost",
  milestone: "Watching",
  tell: "Told",
  reply: "Reply",
  look: "Look",
};

/**
 * Whether the why-line says something the post does not: not when it
 * repeats the words, nor when it is only that the app is yours — on a
 * timeline of your own apps, that is every post.
 */
const saysMore = (item: FeedItem): boolean =>
  !item.reason.startsWith(item.what) &&
  !/^because you (own|work on|pinned) /.test(item.reason);

/**
 * One post: who, where and when; what it says, as a link into the thing;
 * why, when that is news; and one quiet control for the rest — say
 * something (steer a run, tell the crew), dismiss, mute.
 */
export function feedCard(
  item: FeedItem,
  marks: ReadonlyMap<string, Mark> = new Map(),
): Html {
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
      ${avatar(item.actor ?? item.app)}
      <strong class="fcard-who">${item.actor ?? item.app}</strong
      >${nameMark(item.actor === null ? undefined : marks.get(item.actor))}
      <span class="fcard-app muted small">${item.app} · ${timeAgo(item.at)}</span>
      <span class="spacer"></span>
      <span class="badge">${KIND_LABEL[item.kind]}</span>
    </div>
    <p class="fcard-reason"><a href="${item.link}" data-feed-open>${item.what}</a></p>
    ${saysMore(item) ? html`<p class="fcard-why small muted">${item.reason}</p>` : null}
    <details class="fcard-more">
      <summary class="small muted" aria-label="${target ? "Steer, dismiss or mute" : "Tell the crew, dismiss or mute"}">${target ? "Steer" : "Tell"} · more</summary>
      <form method="post" action="${target ?? `/${item.app}/tell`}" class="fcard-form">
        <textarea class="input" name="text" rows="2" maxlength="2000" required aria-label="${target ? "Steer this run" : "Tell the crew"}"></textarea>
        ${btn(target ? "Steer" : "Tell", { size: "sm", variant: "primary" })}
      </form>
      <span class="fcard-acts">
        <button type="button" class="btn btn-sm btn-ghost" data-feed="dismissed" title="Dismiss (x)">Dismiss</button>
        ${item.kind === "ask" || item.kind === "milestone" ? null : html`<button type="button" class="btn btn-sm btn-ghost" data-feed="muted" title="Mute ${item.app}">Mute app</button>`}
      </span>
    </details>
  </article>`;
}

/** The composer's app value for "the forge": no app, so no slash to collide with one. */
export const FORGE_TARGET = "forge";

/** How many thoughts stand at the top of the feed. */
const THOUGHTS_SHOWN = 3;

/** A thought stays at the top for a day, then leaves the feed (it is still kept). */
const THOUGHT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A thought as the owner's post: their own words, verbatim (escaped here,
 * once; line breaks kept by CSS), marked "received". It has no controls.
 */
export function thoughtCard(thought: Thought, who: string): Html {
  return html`<article class="fcard fcard-thought" data-kind="thought" data-thought="${thought.id}">
    <div class="fcard-head">
      ${avatar(who)}
      <strong class="fcard-who">${who}</strong>
      <span class="fcard-app muted small">${timeAgo(thought.receivedAt)}</span>
      <span class="spacer"></span>
      <span class="badge">Received</span>
    </div>
    <p class="fcard-reason fcard-text">${thought.text}</p>
  </article>`;
}

/** The longest tell the composer takes (its textarea's `maxlength`). */
const TELL_MAX = 2000;

/**
 * What a phone's share sheet handed the composer (`share_target` in the web
 * manifest, standards.ts): the title, text and link it sent as query
 * parameters, as one draft. A page's title often repeats in the text, and
 * some apps put the link in the text as well, so nothing is said twice. It
 * is only ever a draft — nothing is sent until the person taps Post.
 */
export function sharedDraft(params: URLSearchParams): string {
  const parts: string[] = [];
  for (const key of ["title", "text", "url"]) {
    const part = (params.get(key) ?? "").trim();
    if (part !== "" && !parts.some((p) => p.includes(part))) parts.push(part);
  }
  return parts.join("\n").slice(0, TELL_MAX);
}

/**
 * The composer: say something to an app's crew, which opens a tell — the
 * home's one primary action. Without a script it posts to the chosen app's
 * own `/tell`; with one it goes through the outbox to `POST
 * /api/v1/feed/tells`, so it survives a dropped connection. Nothing to say
 * it to, and it is the way to make an app instead.
 */
export function composer(ctx: Ctx, user: User): Html {
  const { repos } = writableAppsOf(ctx, user);
  const slug = (r: { ownerName: string; name: string }) => `${r.ownerName}/${r.name}`;
  const noApps = html`${empty({
    icon: "rocket",
    title: "No apps yet",
    note: "Make one, tell the crew what it is, and watch it come up here.",
    action: html`${btn("New app", { href: "/apps/new", variant: "primary" })}
      ${btn("Repositories", { href: `/${user.username}` })}`,
  })}`;
  const form = html`<form id="composer" class="composer" method="post" action="/tell">
    <textarea class="input" name="text" rows="2" maxlength="2000" required placeholder="Tell the crew what should change" aria-label="Tell the crew">${sharedDraft(ctx.url.searchParams)}</textarea>
    <div class="composer-bar">
      ${repos.length === 0
        ? html`<input type="hidden" name="app" value="${FORGE_TARGET}" /><span class="muted small">the forge</span>`
        : html`<select name="app" class="input" aria-label="Send to">
        ${repos.map((r) => html`<option value="${slug(r)}">${slug(r)}</option>`)}
        <option value="${FORGE_TARGET}">the forge</option>
      </select>`}
      <span class="spacer"></span>
      ${btn("Post", { variant: "primary" })}
    </div>
  </form>`;
  return repos.length === 0 ? html`${form}${noApps}` : form;
}

/**
 * One line above the feed, empty unless there is something to say: the feed
 * on screen is old (the service worker served it with no network), or acts
 * are waiting in the outbox. The script fills it; `hidden` until then.
 */
export function feedNote(): Html {
  return html`<p
    id="feed-note"
    class="feed-note small muted"
    role="status"
    data-rendered="${String(Date.now())}"
    data-stale="0"
    hidden
  ></p>`;
}

/** The region: cards, or one line saying there is nothing to do. */
export function feedRegion(user: User, ctx: Ctx): Html {
  // What needs you is pinned above the timeline (`needsYouSection`), so an
  // ask is never a second time a post below it; the feed API keeps them.
  const items = readFeed(ctx.app.db, user, { limit: FEED_FIRST_PAGE }).items.filter(
    (item) => item.kind !== "ask",
  );
  const thoughts = recentThoughts(ctx.app.db, user.id, THOUGHTS_SHOWN, new Date(Date.now() - THOUGHT_AGE_MS).toISOString());
  // Who each poster is, asked once for the page (`core/marks.ts`).
  const marks = marksByName(
    ctx.app.db,
    items.map((item) => item.actor ?? ""),
  );
  return html`<section
    id="live-feed"
    class="feed"
    aria-label="Feed"
    data-live="${FEED_LIVE}"
    data-live-src="/live/feed"
  >
    ${thoughts.map((t) => thoughtCard(t, user.username))}
    ${items.length === 0 && thoughts.length === 0
      ? empty({
          icon: "activity",
          title: "Nothing new",
          note: "When something happens in your apps, it lands here.",
        })
      : items.map((item) => feedCard(item, marks))}
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
${outboxJs}
(function () {
  var feed = document.getElementById('live-feed');
  if (!feed || typeof fetch === 'undefined') return;
  var note = document.getElementById('feed-note');
  var outbox = null;
  try { outbox = forgeOutbox(window.localStorage, function (u, o) { return fetch(u, o); }); } catch (e) {}
  function ago(ms) {
    var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
  }
  function paint() {
    if (!note) return;
    var parts = [];
    if (note && note.getAttribute('data-stale') === '1')
      parts.push('Offline: this feed is from ' + ago(Number(note.getAttribute('data-rendered'))) + '.');
    var n = outbox ? outbox.size() : 0;
    if (n > 0) parts.push(n + (n === 1 ? ' act is' : ' acts are') + ' waiting to send.');
    note.textContent = parts.join(' ');
    note.hidden = parts.length === 0;
  }
  function flush() {
    if (!outbox) return;
    outbox.flush().then(paint);
  }
  function queue(url, payload) {
    if (!outbox) return false;
    outbox.add(url, payload);
    paint();
    flush();
    return true;
  }
  function send(card, kind) {
    return queue('/api/v1/feed/interactions', { item: card.getAttribute('data-item'), kind: kind, app: card.getAttribute('data-app') });
  }
  function gone(card) {
    var cards = Array.prototype.slice.call(feed.querySelectorAll('.fcard'));
    var next = cards[cards.indexOf(card) + 1] || cards[cards.indexOf(card) - 1];
    card.hidden = true;
    if (next) next.focus();
  }
  // Acting is instant: the card goes, the act is kept and sent.
  function act(card, kind) { if (send(card, kind)) gone(card); }
  feed.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-feed],[data-feed-open]') : null;
    var card = t && t.closest('.fcard');
    if (!card) return;
    if (t.hasAttribute('data-feed-open')) { send(card, 'opened'); return; }
    act(card, t.getAttribute('data-feed'));
  });
  // A tell is kept and sent the same way; a steer needs the run, so it
  // stays an ordinary post and waits for the network.
  feed.addEventListener('submit', function (e) {
    var form = e.target;
    var card = form.closest && form.closest('.fcard');
    var box = form.elements && form.elements.text;
    if (!card || !box || !/\\/tell$/.test(form.getAttribute('action') || '')) return;
    var text = box.value.trim();
    if (!text) return;
    if (!queue('/api/v1/feed/tells', { app: card.getAttribute('data-app'), text: text })) return;
    e.preventDefault();
    box.value = '';
    var d = form.closest('details');
    if (d) d.open = false;
  });
  // The composer is a tell too: kept and sent the same way; the box clears
  // at once, and the post arrives in the timeline when the forge says so.
  var composer = document.getElementById('composer');
  if (composer) composer.addEventListener('submit', function (e) {
    var box = composer.elements.text;
    var app = composer.elements.app;
    var text = box ? box.value.trim() : '';
    if (!text || !app || app.value === '${FORGE_TARGET}') return;
    if (!queue('/api/v1/feed/tells', { app: app.value, text: text })) return;
    e.preventDefault();
    box.value = '';
    box.focus();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'x' || e.metaKey || e.ctrlKey || e.altKey) return;
    var a = document.activeElement;
    if (!a || !a.matches || !a.matches('.fcard')) return;
    e.preventDefault();
    act(a, 'dismissed');
  });
  window.addEventListener('online', function () {
    flush();
    // The page on screen came from the cache: the real one is back.
    if (note && note.getAttribute('data-stale') === '1') location.reload();
  });
  // Signing out forgets the last feed and anything not yet sent.
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('action') === '/logout') {
      if (outbox) outbox.clear();
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('clear');
    }
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
  paint();
  flush();
})();
`;
