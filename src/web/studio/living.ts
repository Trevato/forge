/**
 * The home's living pipeline (#8015): the pipeline in four words, what is
 * being built, what just shipped, and the box that tells the crew. Each part
 * is plain rows with a link to the thing it names. Being built and just
 * shipped are one live region (`/live/moving`) that the shared stream
 * redraws when a run or a merge moves; it always holds the same number of
 * rows, so nothing below it shifts.
 */

import type { Database } from "bun:sqlite";
import { MOVING_ROWS, nowOf, readBuilding, readShipped, type MovingRow, type Now } from "../../flow/moving.ts";
import { readPipeline } from "../../flow/pipeline.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { html, type Html } from "../html.ts";
import { fragment } from "../layout.ts";
import { btn, listCard, row, timeAgo } from "../ui.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { NowStage } from "../../flow/now_rows.ts";
import { nowHref } from "../pages/now.ts";
import { writableAppsOf } from "./asks.ts";
import { FORGE_TARGET, sharedDraft } from "./feed.ts";
import { repoBase } from "../chrome.ts";

/** The events that move a build or a shipment. */
const MOVING_LIVE = "run.started,run.finished,pull.merged,pull.opened,pull.closed,app.serving";
const NOW_TTL_MS = 3_000;
// One entry per forge, not per viewer: the counts are forge-wide, so only a site admin is ever shown them.
const nows = new WeakMap<Database, { at: number; now: Now }>();

/** Admin only: the caller has checked. The pipeline counts, read at most every few seconds: the same stages `/boards` draws. */
export function pipelineNow(db: Database, at = Date.now()): Now {
  const kept = nows.get(db);
  if (kept !== undefined && at - kept.at < NOW_TTL_MS) return kept.now;
  const now = nowOf(readPipeline(db, new Date(at)));
  nows.set(db, { at, now });
  return now;
}

/** `check 10 › review 1 › land 3 › live`: each word opens what it counts (`/now/:stage`). */
export function nowLine(now: Now, boards = true): Html {
  // An agent admin has no boards to open: the word is then plain.
  const part = (stage: NowStage, n: number) =>
    boards ? html`<a href="${nowHref(stage)}"><strong>${String(n)}</strong> ${stage}</a>` : html`<span><strong>${String(n)}</strong> ${stage}</span>`;
  return html`<section aria-label="Now">
    <h2 class="small muted">Now</h2>
    <p class="bar" id="now-line">
      ${part("check", now.check)} <span class="muted" aria-hidden="true">›</span>
      ${part("review", now.review)} <span class="muted" aria-hidden="true">›</span>
      ${part("land", now.land)} <span class="muted" aria-hidden="true">›</span>
      ${part("live", now.live)}
    </p>
  </section>`;
}

function listOf(label: string, rows: readonly MovingRow[], empty: string): Html {
  const shown = rows.map((r) =>
    row({
      href: r.href,
      ...(r.who === "" ? {} : { lead: html`<span class="muted small">${r.who}</span>` }),
      title: html`<span class="truncate" title="${r.repo}">${r.title}</span>`,
      trail: html`<span class="muted small">${timeAgo(r.at)}</span>`,
    }),
  );
  // Always MOVING_ROWS rows: a quiet slot is as tall as a busy one.
  for (let i = shown.length; i < MOVING_ROWS; i++)
    shown.push(row({ title: html`<span class="muted small">${i === 0 ? empty : " "}</span>` }));
  return html`<section aria-label="${label}">
    <h2 class="small muted">${label}</h2>
    ${listCard(shown)}
  </section>`;
}

/**
 * The pipeline, then being built and just shipped side by side on a desk and
 * stacked on a phone; one live region. The pipeline counts every repository,
 * private ones too, so only a site admin, who reads them all, sees the line.
 */
export function movingRegion(db: Database, viewer: User): Html {
  const building = readBuilding(db, viewer);
  const shipped = readShipped(db, viewer);
  return html`<div id="live-moving" class="stack" data-live="${MOVING_LIVE}" data-live-src="/live/moving">
    ${viewer.isAdmin ? nowLine(pipelineNow(db), viewer.kind !== "agent") : null}
    <div class="moving">
      ${listOf("Being built", building, "Nothing is being built right now")}
      ${listOf("Just shipped", shipped, "Nothing has shipped yet")}
    </div>
  </div>`;
}

// GET /live/moving — the two lists alone, for the region that shows them.
export function liveMovingFragment(ctx: Ctx): Response {
  const user = ctx.auth.user;
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  if (!user) {
    notePhase(ctx.request, "render", 0);
    return fragment(html``, { status: 404 });
  }
  const body = timePhase(ctx.request, "moving", () => movingRegion(ctx.app.db, user));
  notePhase(ctx.request, "render", 0);
  return fragment(body, { request: ctx.request });
}

/** The box that tells the crew: one line, the app it goes to, Tell. Posts to `/tell` as the composer does. */
export function tellBox(ctx: Ctx, user: User): Html {
  const { repos } = writableAppsOf(ctx, user);
  const slug = (r: { ownerName: string; name: string }) => `${r.ownerName}/${r.name}`;
  return html`<form id="tell-box" class="bar tell-box" method="post" action="/tell">
    <input class="input" name="text" maxlength="2000" required placeholder="Tell the crew…" aria-label="Tell the crew" data-draft="${user.id}" value="${sharedDraft(ctx.url.searchParams).replace(/\s+/g, " ")}" />
    ${repos.length === 0
      ? html`<input type="hidden" name="app" value="${FORGE_TARGET}" />`
      : html`<select name="app" class="input" aria-label="Send to">
          ${repos.map((r) => html`<option value="${slug(r)}">${slug(r)}</option>`)}
          <option value="${FORGE_TARGET}">the forge</option>
        </select>`}
    ${btn("Tell", { variant: "primary" })}
    ${btn("Notes", { href: "/notes", icon: "comment", title: "Your notes and where they stand" })}
    ${btn("Talk", { href: "/talk", icon: "comment", title: "Talk to the forge" })}
  </form>`;
}

/** Your apps as chips, each a link to the app, and a plus for a new one. */
export function appChips(ctx: Ctx, user: User): Html {
  const { repos } = writableAppsOf(ctx, user);
  return html`<section aria-label="Your apps" id="live-chips" data-live="app.serving,app.stopped,app.created,app.deleted" data-live-src="/live/chips">
    <h2 class="small muted">Your apps</h2>
    <div class="bar">
      ${repos.slice(0, 12).map((r) => btn(r.name, { href: repoBase(r), size: "sm" }))}
      ${btn("New app", { href: "/apps/new", size: "sm", icon: "plus" })}
      ${repos.length > 12 ? btn(`All ${repos.length}`, { href: "/apps", size: "sm" }) : null}
    </div>
  </section>`;
}

// GET /live/chips — the chips alone.
export function liveChipsFragment(ctx: Ctx): Response {
  const user = ctx.auth.user;
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  notePhase(ctx.request, "render", 0);
  if (!user) return fragment(html``, { status: 404 });
  return fragment(appChips(ctx, user), { request: ctx.request });
}
