/**
 * GET /:owner/:name/events — what happened on a repository, newest first.
 *
 * The same read as MCP `events` and the API (`eventsPage`): the audience
 * filter runs there, so a webhook's URL and an app's variable names reach
 * only the admins. One row per event — who, what, when — in the words the
 * activity feed uses, linked where the event has a page. Fifty a page;
 * `?cursor=` reads the next. Server-rendered, no script.
 */

import { EVENTS_LIMIT_DEFAULT, eventsPage, validEventsCursor } from "../../core/events_page.ts";
import type { ForgeEvent } from "../../core/events.ts";
import { getUsersByIds } from "../../core/users.ts";
import { eventActor, eventVerb } from "../../design/activity.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage, repoBase, scopeHeader } from "../chrome.ts";
import { pushedBranch } from "../feeds.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { localScope } from "../scope.ts";
import { avatar, empty, listCard, pager, row, time } from "../ui.ts";

/** Where an event has a page: its issue or pull, a push's commits. */
function linkOf(base: string, event: ForgeEvent): string | undefined {
  const number = event.payload["number"];
  if (typeof number === "number" && Number.isInteger(number))
    return `${base}/${event.kind.startsWith("pull.") ? "pulls" : "issues"}/${number}`;
  return event.kind === "push" ? `${base}/commits` : undefined;
}

function eventRows(ctx: Ctx, base: string, events: readonly ForgeEvent[]): Html {
  const actors = getUsersByIds(
    ctx.app.db,
    events.map((e) => e.actorId ?? "").filter(Boolean),
  );
  return listCard(
    events.map((event) => {
      const who = eventActor(event, event.actorId === null ? undefined : actors.get(event.actorId)?.username);
      const number = event.payload["number"];
      const subject =
        typeof number === "number" ? `#${number}` : event.kind === "push" ? pushedBranch(event) : "";
      const href = linkOf(base, event);
      return row({
        lead: avatar(who),
        title: `${who} ${eventVerb(event)}${subject === "" ? "" : `: ${subject}`}`,
        trail: time(event.createdAt),
        ...(href === undefined ? {} : { href, nav: true }),
      });
    }),
  );
}

export function eventsList(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const raw = ctx.url.searchParams.get("cursor");
  if (raw !== null && !validEventsCursor(raw)) return notFoundPage(ctx);
  const base = repoBase(repo);
  const read = eventsPage(ctx.app.db, repo.id, ctx.auth.user, EVENTS_LIMIT_DEFAULT, raw ?? undefined);
  const rendering = performance.now();
  const scope = localScope(ctx, repo);
  const body = html`${scopeHeader(ctx, scope, "events")}
    <div class="mt">
      ${read.items.length === 0
        ? empty({ icon: "activity", title: "No events yet", note: "Pushes, merges and deploys land here." })
        : eventRows(ctx, base, read.items)}
    </div>
    ${pager({
      ...(read.next_cursor === null ? {} : { next: `${base}/events?cursor=${encodeURIComponent(read.next_cursor)}` }),
    })}`;
  const response = page({
    ctx,
    title: `Events · ${repo.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
