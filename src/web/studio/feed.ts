/**
 * The home's feed: the ranked read model (`feed/feed.ts`) as posts (#599).
 * Each post is who did it, what it says in its own words as a link straight
 * into the thing, a small line of why it is here, a way to say something to
 * the crew from where you are, and dismiss / mute. Above them, the composer. The first
 * page is server-rendered; the same region answers at `/live/feed` so a
 * forge event refreshes it through the live-regions client, like the shelf.
 * Every string on a card is plain text and is escaped here, once.
 */

import { COMPOSER_FIELDS, TELL_MAX, sharedDraft, shareToken } from "../share_target.ts";
import { chipCounts } from "../../feed/chips.ts";
import { chipsOf, KIND_CHIPS, type KindChip } from "../../core/feed_chips.ts";
import { marksByName, type Mark } from "../../core/marks.ts";
import { getUsersByIds, type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { placementsOf, type Placement } from "../../core/placements.ts";
import { recentThoughts, type Thought } from "../../core/thoughts.ts";
import { parseCursor, readFeedPage } from "../../feed/feed.ts";
import { parseBefore, readTimeline, TIMELINE_START } from "../../feed/timeline.ts";
import type { FeedItem } from "../../feed/rank.ts";
import { replyPath, replyRepo, threadOf } from "../../feed/reply.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { getRepo, getRepoById } from "../../core/repos.ts";
import { DEFAULT_PAGE, looksForEnv, lookUrl } from "../../core/looks.ts";
import { mayFetchLook, pictured } from "../pages/looks.ts";
import { dividers } from "./day_divider.ts";
import { html, type Html } from "../html.ts";
import { DISMISS_KEY } from "../script_keys.ts";
import { fragment } from "../layout.ts";
import { draftJs } from "../draft.ts";
import { outboxJs } from "../outbox.ts";
import { avatar, btn, card, disclosure, empty, hintAttr, nameMark, row, stateBadge, time } from "../ui.ts";
import { stepLink } from "./step_link.ts";
import { writableAppsOf } from "./asks.ts";

/** Events that can change what the feed says. */
export const FEED_LIVE =
  "run.finished,issue.opened,issue.commented,pull.commented,pull.opened,pull.merged,pull.reviewed,pull.closed,look.taken,app.serving,issue.blocked,issue.unblocked,crew.governed,issue.closed,decision.*,thought.received,thought.placed";

export const FEED_FIRST_PAGE = 20;

const RUN_LINK = /^\/[^/]+\/[^/]+\/runs\/[A-Za-z0-9_-]+$/;

const KIND_LABEL: Record<FeedItem["kind"], string> = {
  run: "Run",
  ask: "Needs you",
  pull: "Pull request",
  decision: "Decision",
  map: "Map",
  cost: "Cost",
  milestone: "Watching",
  choose: "Choose",
  tell: "Issue",
  reply: "Reply",
  look: "Look",
  release: "Release",
};

/**
 * Whether the why-line says something the post does not: not when it
 * repeats the words, nor when it is only that the app is yours — on a
 * timeline of your own apps, that is every post.
 */
const saysMore = (item: FeedItem): boolean =>
  !item.reason.startsWith(item.what) &&
  !/^because you (own|work on|pinned) /.test(item.reason);

/** A look post's thumbnail: its address and the size it is drawn at, so nothing shifts. */
export interface FeedPicture {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

/** The thumbnail is drawn at 160×100, the thumb's 8:5. */
export const FEED_PICTURE = { width: 160, height: 100 } as const;

/**
 * The thumbnail each look post shows, by post id — only one this viewer
 * may fetch (`mayFetchLook`), so a post never carries a broken image.
 */
export function picturesFor(ctx: Ctx, items: readonly FeedItem[]): Map<string, FeedPicture> {
  const out = new Map<string, FeedPicture>();
  for (const item of items) {
    if (item.kind !== "look" || item.look === undefined) continue;
    const [owner = "", name = ""] = item.app.split("/");
    const repo = getRepo(ctx.app.db, owner, name);
    const record = repo && getAppByRepo(ctx.app.db, repo.id);
    if (!repo || !record) continue;
    const home = looksForEnv(ctx.app.db, record.id, item.look.env).filter(
      (l) => l.page === DEFAULT_PAGE && l.commitOid === item.look!.commitOid,
    );
    const thumb = pictured(home, "thumb");
    if (thumb === undefined || !mayFetchLook(ctx, repo, record, thumb)) continue;
    out.set(item.id, { src: lookUrl(`/${repo.ownerName}/${repo.name}`, thumb), ...FEED_PICTURE });
  }
  return out;
}

/** How a pull or an issue ended, as the quiet word beside a post's time. */
function settledBadge(settled: FeedItem["settled"]): Html | null {
  if (settled === undefined) return null;
  return stateBadge(settled === "merged" ? "merged" : "closed", settled === "parked");
}

/**
 * The count of likes and, for a signed-in viewer, the button that toggles
 * theirs. A form that posts back to the feed, so it works without a script;
 * the script updates the same two nodes in place. The label never changes
 * (the pressed state is `aria-pressed`) and the count is drawn at a fixed
 * width, so a press moves nothing.
 */
function likeBar(item: FeedItem): Html {
  const likes = item.likes ?? 0;
  const liked = item.liked ?? false;
  return html`<form method="post" action="/feed/like" class="like" data-like>
    <input type="hidden" name="item" value="${item.id}" />
    <input type="hidden" name="app" value="${item.app}" />
    <input type="hidden" name="back" value="/feed" />
    <input type="hidden" name="act" value="${liked ? "unlike" : "like"}" />
    <button type="submit" class="btn" data-variant="ghost" data-size="sm" aria-pressed="${liked ? "true" : "false"}">Like <span data-likes>${likes}</span></button>
  </form>`;
}

/**
 * One post: who, where and when; what it says, as a link into the thing;
 * why, when that is news; and one quiet control for the rest — say
 * something (steer a run, tell the crew), dismiss, mute.
 */
export function feedCard(
  item: FeedItem,
  marks: ReadonlyMap<string, Mark> = new Map(),
  picture?: FeedPicture,
  mayReply = false,
): Html {
  // The thread must be in the post's own app: that is the repository `mayReply` was asked about.
  const linked = mayReply ? threadOf(item.link) : undefined;
  const thread = linked !== undefined && `${linked.owner}/${linked.name}` === item.app ? linked : undefined;
  const reply = thread !== undefined;
  const steer = item.kind === "run" || item.kind === "cost";
  const target = steer && RUN_LINK.test(item.link) ? `${item.link}/steer` : null;
  const head = html`${avatar(item.actor ?? item.app)}
      <strong class="break">${item.actor ?? item.app}</strong
      >${nameMark(item.actor === null ? undefined : marks.get(item.actor))}
      <span class="muted small break">${item.app} · ${time(item.at)}</span>
      ${settledBadge(item.settled)}
      <span class="spacer"></span>
      <span class="badge">${KIND_LABEL[item.kind]}</span>`;
  const body = html`<p class="break"><a href="${item.link}" data-feed-open>${item.what}</a></p>
    ${item.lines === undefined
      ? null
      : html`<ul class="list">${item.lines.map((l) => row({ href: l.link, title: l.text }))}${item.more ? row({ title: `and ${item.more} more` }) : null}</ul>`}
    ${picture === undefined
      ? null
      : html`<a class="look" data-slot="feed" href="${item.link}" tabindex="-1" aria-hidden="true"
          ><img src="${picture.src}" width="${picture.width}" height="${picture.height}" alt="" loading="lazy" decoding="async"
        /></a>`}
    ${item.step === undefined ? null : html`<p class="break">${stepLink(item.step)}</p>`}
    ${saysMore(item) ? html`<p class="small muted break">${item.reason}</p>` : null}
    ${likeBar(item)}`;
  const foot = disclosure(
    `${reply ? "Reply or " : ""}${target ? "Steer" : "Tell"} · more`,
    html`${reply
        ? html`<form method="post" action="${thread === undefined ? "" : replyPath(thread)}" class="stack">
        <input type="hidden" name="back" value="feed" />
        <textarea class="input" name="body" rows="2" maxlength="20000" required aria-label="Reply on ${item.what}"></textarea>
        <span class="bar">${btn("Reply", { size: "sm", variant: "primary" })}</span>
      </form>`
        : null}<form method="post" action="${target ?? `/${item.app}/tell`}" class="stack">
        <textarea class="input" name="text" rows="2" maxlength="2000" required aria-label="${target ? "Steer this run" : "Tell the crew"}"></textarea>
        <span class="bar">${btn(target ? "Steer" : "Tell", reply ? { size: "sm" } : { size: "sm", variant: "primary" })}</span>
      </form>
      <span class="bar">
        <button type="button" class="btn" data-variant="ghost" data-size="sm" data-feed="dismissed" ${hintAttr(DISMISS_KEY)}>Dismiss</button>
        ${item.kind === "ask" || item.kind === "milestone" || item.kind === "choose" ? null : html`<button type="button" class="btn" data-variant="ghost" data-size="sm" data-feed="muted" title="Mute ${item.app}">Mute app</button>`}
      </span>`,
    { small: true, label: target ? "Steer, dismiss or mute" : reply ? "Reply, tell the crew, dismiss or mute" : "Tell the crew, dismiss or mute" },
  );
  return card(body, {
    head,
    foot,
    attrs: html`data-nav tabindex="0" data-item="${item.id}" data-app="${item.app}" data-kind="${item.kind}"`,
  });
}

/** The composer's app value for "the forge": no app, so no slash to collide with one. */
export const FORGE_TARGET = "forge";

/** How many thoughts stand at the top of the feed. */
const THOUGHTS_SHOWN = 3;

/** A thought stays at the top for a day, then leaves the feed (it is still kept). */
const THOUGHT_AGE_MS = 24 * 60 * 60 * 1000;

/** Text with its line breaks kept: each line escaped, a `<br>` between. */
const lines = (text: string): Html[] =>
  text.split(/\r?\n/).map((line, i) => (i === 0 ? html`${line}` : html`<br />${line}`));

/**
 * A thought as the owner's post: their own words, verbatim (escaped here,
 * once; line breaks kept by CSS), marked "received". It has no controls.
 */
export function thoughtCard(thought: Thought, who: string, placement?: Placement): Html {
  const head = html`${avatar(who)}
      <strong>${who}</strong>
      <span class="muted small">${time(thought.receivedAt)}</span>
      <span class="spacer"></span>
      <span class="badge">Received</span>`;
  return card(
    html`<p class="break">${lines(thought.text)}</p>
    ${placement ? replyUnder(placement) : ""}`,
    { head, attrs: html`data-kind="thought" data-thought="${thought.id}"` },
  );
}

/** The planner's answer under a thought: one or two lines, `#N` linking to the issue it names. */
export function replyUnder(placement: Placement): Html {
  const where = new Map(placement.placed.map((p) => [p.number, `${p.repo}/${p.pull === p.number ? "pulls" : "issues"}`]));
  const parts = placement.reply.split(/(#\d+)/).map((part) => {
    const repo = /^#(\d+)$/.test(part) ? where.get(Number(part.slice(1))) : undefined;
    return repo === undefined ? part : html`<a href="/${repo}/${part.slice(1)}">${part}</a>`;
  });
  return html`<p class="small break" data-placement="${placement.kind}"><span class="muted">Planner · ${placement.kind}</span> ${parts}</p>`;
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
    scene: "anvil",
    title: "No apps yet",
    note: "Make one, tell the crew what it is, and watch it come up here.",
    action: html`${btn("New app", { href: "/apps/new", variant: "primary" })}
      ${btn("Repositories", { href: `/${user.username}` })}`,
  })}`;
  const shared = sharedDraft(ctx.url.searchParams);
  const form = html`<form id="composer" class="stack" method="post" action="/tell">
    <input type="hidden" name="${COMPOSER_FIELDS.back}" value="/feed" />
    ${shared === "" ? "" : html`<input type="hidden" name="${COMPOSER_FIELDS.once}" value="${shareToken(user.id, shared)}" />`}
    <textarea class="input" name="${COMPOSER_FIELDS.text}" rows="2" maxlength="${String(TELL_MAX)}" required placeholder="Tell the crew what should change" aria-label="Tell the crew" data-draft="${user.id}">${shared}</textarea>
    <div class="bar">
      ${repos.length === 0
        ? html`<input type="hidden" name="${COMPOSER_FIELDS.app}" value="${FORGE_TARGET}" /><span class="muted small">the forge</span>`
        : html`<select name="${COMPOSER_FIELDS.app}" class="input" aria-label="Send to">
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

const CHIP_LABEL: Record<KindChip, string> = {
  reviews: "Pull requests",
  decisions: "Decisions",
  crew: "Crew words",
  releases: "Releases",
};

/**
 * The chips: a button per kind and per person in sight (and per person
 * already switched off, so it can come back). Pressed is shown; pressing
 * switches it off, saved with the mutes (`/api/v1/feed/chips`).
 */
function chipsBar(user: User, ctx: Ctx, items: readonly FeedItem[]): Html {
  const chips = chipsOf(ctx.app.db, user.id);
  const hidden = [...getUsersByIds(ctx.app.db, [...chips.people]).values()];
  const names = new Set([
    ...hidden.map((u) => u.username),
    ...items.flatMap((i) => (i.actor === null ? [] : [i.actor])),
  ]);
  names.delete(user.username);
  const hiddenNames = new Set(hidden.map((u) => u.username));
  const counts = chipCounts(items);
  const chip = (kind: string, value: string, label: string, shown: boolean): Html =>
    html`<button
      type="button"
      class="btn feed-chip" data-variant="ghost" data-size="sm"
      data-chip="${kind}"
      data-value="${value}"
      aria-pressed="${String(shown)}"
    >${label}</button>`;
  return html`<div class="bar feed-chips" role="group" aria-label="Filter the feed">
    ${KIND_CHIPS.flatMap((k) => {
      const count = counts.get(k) ?? 0;
      // Nothing on the page to filter: not drawn, unless switched off (it must come back on).
      if (count === 0 && !chips.kinds.has(k)) return [];
      return [chip("kind", k, count === 0 ? CHIP_LABEL[k] : `${CHIP_LABEL[k]} ${count}`, !chips.kinds.has(k))];
    })}
    ${[...names].sort().map((n) => chip("person", n, n, !hiddenNames.has(n)))}
  </div>`;
}

/** What the region shows, read: the posts, the thoughts, where they sit, who posted. */
function readRegion(user: User, ctx: Ctx) {
  // What needs you is pinned above the timeline (`needsYouSection`), so an
  // ask is never a second time a post below it; the feed API keeps them.
  // `?cursor=` is a page the line below the last post pointed at; one not issued here is the first page.
  const cursor = parseCursor(ctx.url.searchParams.get("cursor") ?? "");
  // `?before=` is the timeline, newest first, deeper than the ranked page reaches (`feed/timeline.ts`).
  const before = parseBefore(ctx.url.searchParams.get("before") ?? "");
  const page =
    before === undefined
      ? readFeedPage(ctx.app.db, user, {
          limit: FEED_FIRST_PAGE,
          withoutAsks: true,
          phase: (name, ms) => notePhase(ctx.request, name, ms),
          ...(cursor === undefined ? {} : { cursor }),
        })
      : {
          ...readTimeline(ctx.app.db, user, {
            limit: FEED_FIRST_PAGE,
            phase: (name, ms) => notePhase(ctx.request, name, ms),
            ...(before.id === undefined ? {} : { before: before.id }),
          }),
          quiet: { count: 0, repoId: null },
        };
  const timeline = before !== undefined;
  const asked = ctx.url.searchParams.get("before") ?? "";
  const items = page.items;
  // The day the page before ended on, so a continuing page draws no divider twice (`day_divider.ts`).
  const day = cursor === undefined && !timeline ? "" : (ctx.url.searchParams.get("day") ?? "");
  const lastDayOnPage = Number.isFinite(Date.parse(day)) ? new Date(day).toISOString() : undefined;
  const thoughts = recentThoughts(ctx.app.db, user.id, THOUGHTS_SHOWN, new Date(Date.now() - THOUGHT_AGE_MS).toISOString());
  const placed = placementsOf(ctx.app.db, thoughts.map((t) => t.id));
  // Who each poster is, asked once for the page (`core/marks.ts`).
  const marks = marksByName(
    ctx.app.db,
    items.map((item) => item.actor ?? ""),
  );
  const quiet = page.quiet;
  const quietRepo = quiet.repoId === null ? undefined : getRepoById(ctx.app.db, quiet.repoId);
  const quietLink = quietRepo === undefined ? "/explore" : `/${quietRepo.ownerName}/${quietRepo.name}/runs?kind=agent`;
  return { items, next: page.next_cursor, cursor, timeline, asked, lastDayOnPage, thoughts, placed, marks, pictures: picturesFor(ctx, items), quiet: quiet.count, quietLink };
}

/** The one line an empty timeline says; the tell box above it is the action. */
export const EMPTY_FEED = "Nothing yet. Tell the crew what to build.";

/** The region: cards, or one line saying there is nothing to do. */
export function feedRegion(user: User, ctx: Ctx): Html {
  return drawRegion(user, ctx, readRegion(user, ctx));
}

/**
 * The line under the last post: how far back the page reaches and the way
 * to older ones, or that there is nothing older.
 */
export function caughtUp(items: readonly FeedItem[], next: string | null, cursor?: unknown, timeline = false): Html | null {
  // Ranked by score, not time: the last card is not always the oldest.
  const oldest = items.reduce<string | undefined>((min, item) => (min === undefined || item.at < min ? item.at : min), undefined);
  // A page the filters emptied can still have older posts behind it: keep the way on.
  if (oldest === undefined && next === null) return null;
  const newest = cursor === undefined && !timeline ? html`` : html`<a href="/feed">Newest</a>`;
  // The ranked page ends where its window does; the log goes on, newest first.
  const deeper = timeline ? html`` : html`<a href="/feed?before=${TIMELINE_START}">Everything, newest first</a>`;
  const older = (n: string) => timeline
    ? html`<a href="/feed?before=${encodeURIComponent(n)}">Older posts</a>`
    : html`<a href="/feed?cursor=${encodeURIComponent(n)}&day=${encodeURIComponent(items[items.length - 1]?.at ?? "")}">Older posts</a>`;
  return next === null
    ? html`<p class="bar muted small" data-caught-up="end"><span>${timeline ? html`That's every post` : html`That's everything`}</span><span class="spacer"></span>${newest}${deeper}</p>`
    : html`<p class="bar muted small" data-caught-up="more">
        <span>${oldest === undefined ? "Nothing to show on this page" : html`You're caught up to ${time(oldest)}`}</span>
        <span class="spacer"></span>
        ${newest}
        ${older(next)}
      </p>`;
}

function drawRegion(user: User, ctx: Ctx, read: ReturnType<typeof readRegion>): Html {
  const { items, next, cursor, timeline, asked, lastDayOnPage, thoughts, placed, marks, pictures, quiet, quietLink } = read;
  const now = new Date();
  // One divider per change of day between neighbours, in the order the feed already has.
  const posts: Html[] = [];
  let before = lastDayOnPage;
  // Whether this viewer may reply in a repository, asked once per app on the page.
  const mayReply = new Map<string, boolean>();
  const mayReplyOn = (app: string): boolean => {
    let may = mayReply.get(app);
    if (may === undefined) mayReply.set(app, (may = replyRepo(ctx.app.db, user, app) !== undefined));
    return may;
  };
  for (const item of items) {
    const [label] = dividers([item.at], now, before);
    if (label !== undefined) posts.push(html`<p class="muted small" role="separator" aria-label="${label}" data-day-divider="${label}">${label}</p>`);
    posts.push(feedCard(item, marks, pictures.get(item.id), mayReplyOn(item.app)));
    before = item.at;
  }
  const liveQuery = [
    timeline ? `before=${encodeURIComponent(asked)}` : "",
    cursor === undefined ? "" : `cursor=${encodeURIComponent(`${cursor.score}|${cursor.id}`)}`,
    cursor === undefined || lastDayOnPage === undefined ? "" : `day=${encodeURIComponent(lastDayOnPage)}`,
  ].filter(Boolean).join("&");
  return html`<section
    id="live-feed"
    class="feed"
    aria-label="Feed"
    data-live="${FEED_LIVE}"
    data-live-src="/live/feed${liveQuery === "" ? "" : `?${liveQuery}`}"
  >
    ${chipsBar(user, ctx, items)}
    ${thoughts.map((t) => thoughtCard(t, user.username, placed.get(t.id)))}
    ${items.length === 0 && thoughts.length === 0
      ? empty({ title: EMPTY_FEED })
      : posts}
    ${quiet === 0
      ? ""
      : html`<p class="small muted"><a href="${quietLink}">${quiet} quiet ${quiet === 1 ? "run" : "runs"} in the last 24 h</a></p>`}
    ${caughtUp(items, next, cursor, timeline)}
  </section>`;
}

// GET /live/feed — the feed alone, for the region that shows it.
export function liveFeedFragment(ctx: Ctx): Response {
  const user = ctx.auth.user;
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!user) return fragment(html``, { status: 404 });
  const read = timePhase(ctx.request, "feed", () => readRegion(user, ctx));
  const rendering = performance.now();
  const response = fragment(drawRegion(user, ctx, read), { request: ctx.request });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** Offline: the worker keeps the last home and the page that shows it is stale (`sw.ts`). */
export const registerWorkerJs = `if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});`;

/**
 * When a card is hidden, the day divider just above it goes with it, unless
 * a later card of that day is still showing — then the divider moves down to
 * it, so a day never reads as a heading over nothing.
 */
export const dayKeepJs = /* js */ `
function keepDay(card) {
  var div = card.previousElementSibling;
  if (!div || !div.hasAttribute('data-day-divider')) return;
  var next = card.nextElementSibling;
  while (next && next.hidden) next = next.nextElementSibling;
  if (next && next.hasAttribute('data-item')) {
    next.parentNode.insertBefore(div, next);
    div.hidden = false;
  } else {
    div.hidden = true;
  }
}
`;

/**
 * j/k and enter are the shell's (`data-nav`). Here: `x` dismisses the card
 * in focus, the buttons dismiss or mute, and opening a card is recorded.
 * Interactions go to the feed API, same-origin with the session cookie.
 */
export const feedJs = /* js */ `
${outboxJs}
${draftJs}
${dayKeepJs}
(function () {
  var feed = document.getElementById('live-feed');
  if (!feed || typeof fetch === 'undefined') return;
  var note = document.getElementById('feed-note');
  var outbox = null;
  var problem = '';
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
    if (problem) parts.push(problem);
    if (said) parts.unshift(said);
    note.textContent = parts.join(' ');
    note.hidden = parts.length === 0;
  }
  var said = '';
  function say(t) { said = t; paint(); setTimeout(function () { if (said === t) { said = ''; paint(); } }, 4000); }
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
    var cards = Array.prototype.slice.call(feed.querySelectorAll('[data-item]'));
    var next = cards[cards.indexOf(card) + 1] || cards[cards.indexOf(card) - 1];
    card.hidden = true;
    keepDay(card);
    if (next) next.focus();
  }
  // Acting is instant: the card goes, the act is kept and sent.
  function act(card, kind) {
    var app = card.getAttribute('data-app');
    if (send(card, kind)) { gone(card); say((kind === 'muted' ? 'Muted ' + app + '.' : 'Dismissed.') ); }
  }
  // A chip flips at once; the saved filter then redraws the region in place
  // (the same fragment the live region pulls), keeping scroll and focus. A
  // refusal puts the chip back and says why in the note.
  function fail(c, was, why) {
    c.setAttribute('aria-pressed', was);
    problem = why;
    paint();
  }
  function chip(c) {
    var was = c.getAttribute('aria-pressed');
    var kind = c.getAttribute('data-chip');
    var value = c.getAttribute('data-value');
    c.setAttribute('aria-pressed', was === 'true' ? 'false' : 'true');
    problem = '';
    paint();
    fetch('/api/v1/feed/chips', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: kind, value: value, hidden: was === 'true' }) })
      .then(function (r) {
        if (r.ok) return refetch(kind, value);
        fail(c, was, r.status === 401 || r.status === 403
          ? 'The filter was not saved because you are signed out. Sign in again and press the chip once more.'
          : 'The filter was not saved because the server refused it. Reload the page and try again.');
      })
      .catch(function () { fail(c, was, 'The filter was not saved because there is no connection. Check it and press the chip again.'); });
  }
  function refetch(kind, value) {
    return fetch(feed.getAttribute('data-live-src') || '/live/feed', { headers: { accept: 'text/html' }, credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw r; return r.text(); })
      .then(function (text) {
        var holder = document.createElement('template');
        holder.innerHTML = text;
        var fresh = holder.content.querySelector('#live-feed');
        if (!fresh) return;
        var had = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-chip]');
        feed.innerHTML = fresh.innerHTML;
        feed.dispatchEvent(new CustomEvent('forge:swapped', { bubbles: true }));
        if (had) {
          var all = feed.querySelectorAll('[data-chip]');
          for (var i = 0; i < all.length; i++)
            if (all[i].getAttribute('data-chip') === kind && all[i].getAttribute('data-value') === value) all[i].focus();
        }
      })
      .catch(function () { problem = 'The filter was saved, but the feed could not be refreshed. Reload the page to see it.'; paint(); });
  }
  feed.addEventListener('click', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('[data-chip]') : null;
    if (c) { chip(c); return; }
    var t = e.target && e.target.closest ? e.target.closest('[data-feed],[data-feed-open]') : null;
    var card = t && t.closest('[data-item]');
    if (!card) return;
    if (t.hasAttribute('data-feed-open')) { send(card, 'opened'); return; }
    act(card, t.getAttribute('data-feed'));
  });
  // A like flips at once and then takes the count the forge answers; a
  // refusal puts it back. Without fetch the form posts back to the feed.
  function like(form, e) {
    var btn = form.querySelector('button');
    var count = form.querySelector('[data-likes]');
    if (!btn || !count) return;
    e.preventDefault();
    var was = btn.getAttribute('aria-pressed') === 'true';
    var n = Number(count.textContent) || 0;
    var show = function (on, total) { var a = form.querySelector('[name=act]'); if (a) a.value = on ? 'unlike' : 'like'; btn.setAttribute('aria-pressed', on ? 'true' : 'false'); count.textContent = String(total); };
    var body = new URLSearchParams(new FormData(form)).toString();
    show(!was, Math.max(0, n + (was ? -1 : 1)));
    fetch(form.getAttribute('action'), { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: body })
      .then(function (r) { if (!r.ok) throw r; return r.json(); })
      .then(function (a) { show(a.liked, a.likes); })
      .catch(function () { show(was, n); problem = 'The like was not saved. Check your connection and press Like again.'; paint(); });
  }
  // A tell is kept and sent the same way; a steer needs the run, so it
  // stays an ordinary post and waits for the network.
  feed.addEventListener('submit', function (e) {
    var form = e.target;
    var card = form.closest && form.closest('[data-item]');
    if (card && form.hasAttribute && form.hasAttribute('data-like')) { like(form, e); return; }
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
  var draft = null;
  if (composer && composer.elements.text && outbox) {
    var draftBox = composer.elements.text;
    draft = forgeDraft(window.localStorage, draftBox, 'draft.' + draftBox.dataset.draft + location.pathname, function (fn, ms) { setTimeout(fn, ms); });
    draft.restore();
    draftBox.addEventListener('input', draft.typed);
  }
  if (composer) composer.addEventListener('submit', function (e) {
    var box = composer.elements.text;
    var app = composer.elements.app;
    var text = box ? box.value.trim() : '';
    if (!text || !app) return;
    // Sent from here, or posted natively (the forge target): either way the
    // words are gone from the box, so the saved copy goes too.
    if (draft) draft.clear();
    if (app.value === '${FORGE_TARGET}') return;
    if (!queue('/api/v1/feed/tells', { app: app.value, text: text })) return;
    e.preventDefault();
    box.value = '';
    box.focus();
    outbox.flush().then(function (r) { if (r.refused && draft) draft.refused(text); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== '${DISMISS_KEY}' || e.metaKey || e.ctrlKey || e.altKey) return;
    var a = document.activeElement;
    if (!a || !a.matches || !a.matches('[data-item]') || !feed.contains(a)) return;
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
      if (draft) draft.forgetAll();
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('clear');
    }
  });
  ${registerWorkerJs}
  paint();
  flush();
})();
`;
