/**
 * Moderating what visitors send from an app's forge button, over the API:
 * `GET …/app/notes` lists the notes and the banned senders, and
 * `POST …/app/notes/:id/hide`, `…/ban` and `…/unban` act on one note. Admins
 * of the repository only; the rules live in `actions/app_notes.ts`.
 */

import { moderateNote, ownerNote, ownerNotes, unbanSender } from "../../actions/app_notes.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { loadRepo } from "../api.ts";
import type { Ctx, Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { apiError, forbidden, json, notFound, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

/** The repository and its app, or the refusal. */
function target(ctx: Ctx) {
  const denied = requireScope(ctx, "rw");
  if (denied) return denied;
  const repo = loadRepo(ctx);
  if (!repo) return notFound();
  const record = getAppByRepo(ctx.app.db, repo.id);
  if (record === undefined) return notFound();
  return { repo, record };
}

export function appNoteRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/repos/:owner/:name/app/notes", (ctx) => {
    const t = target(ctx);
    if (t instanceof Response) return t;
    const seen = ownerNotes(ctx.app, t.record, t.repo, ctx.auth.user);
    if (seen === undefined) return forbidden();
    // Only after the access check: a refusal never carries or honours a tag.
    const text = JSON.stringify(seen);
    const etag = weakEtag(`${ctx.auth.user?.id ?? ""}\n${text}`);
    const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
    if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
    return json(seen, 200, headers);
  });

  router.add("POST", "/api/v1/repos/:owner/:name/app/notes/:id/hide", moderation("hide"));
  router.add("POST", "/api/v1/repos/:owner/:name/app/notes/:id/ban", moderation("ban"));
  router.add("POST", "/api/v1/repos/:owner/:name/app/notes/:id/unban", moderation("unban"));
}

function moderation(action: "hide" | "ban" | "unban"): Handler {
  return async (ctx) => {
    const t = target(ctx);
    if (t instanceof Response) return t;
    const id = ctx.params.id ?? "";
    const done =
      action === "unban"
        ? unbanSender(ctx.app, t.record, t.repo, ctx.auth.user, id)
        : await moderateNote(ctx.app, t.record, t.repo, ctx.auth.user, id, action);
    if (!done.ok) {
      if (done.error === "forbidden") return forbidden();
      if (done.error === "not_found") return notFound();
      return apiError("unavailable", 503, "that could not be done just now");
    }
    const note = ownerNote(ctx.app, t.record, t.repo, ctx.auth.user, id);
    return note === undefined ? notFound() : json(note);
  };
}
