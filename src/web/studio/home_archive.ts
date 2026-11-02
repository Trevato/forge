/**
 * Archiving apps from the home: an admin ticks apps in the rail and archives
 * them in one step. It is the fleet's own `archive` operation over the ticked
 * repositories (`actions/fleet.ts`) — nothing new is written here — and the
 * page that answers lists what was archived with the operation's undo.
 */

import { applyFleetIds, getFleetOp, undoFleetOp } from "../../actions/fleet.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { signInFirst, NOT_ADMIN_HERE, forbiddenPage } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { btn } from "../ui.ts";
import { MAX_ROWS } from "../../fleet/selection.ts";

/** The ticked repository ids, once each, as long as they are plausible ids. */
function picked(form: Awaited<ReturnType<typeof readForm>>): string[] {
  if (form instanceof Response) return [];
  const ids = form
    .getAll("repo")
    .filter((v): v is string => typeof v === "string" && /^[\w-]{1,64}$/.test(v));
  return [...new Set(ids)];
}

// POST /home/archive — archive the ticked apps, a site admin's.
export async function homeArchive(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  if (!ctx.auth.user.isAdmin) return forbiddenPage(ctx, NOT_ADMIN_HERE);
  const ids = picked(form);
  if (ids.length === 0 || ids.length > MAX_ROWS)
    return redirect("/", {
      url: ctx.url,
      forgeUrl: ctx.app.config.url,
      flash: { tone: "danger", message: "Tick the apps to archive first." },
    });
  const op = await applyFleetIds(
    ctx.app,
    ctx.auth.user,
    "repo",
    ids,
    `home: ${ids.length} selected`,
    { verb: "archive", value: true },
  );
  if (!op.ok)
    return redirect("/", {
      url: ctx.url,
      forgeUrl: ctx.app.config.url,
      flash: { tone: "danger", message: op.error.message },
    });
  return redirect(`/home/archived/${op.value.id}`);
}

// GET /home/archived/:op — what was archived, and the undo.
export function homeArchived(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  const found = timePhase(ctx.request, "op", () =>
    getFleetOp(ctx.app, user, ctx.params.op ?? ""),
  );
  if (!found.ok || found.value.verb !== "archive")
    return new Response("not found", { status: 404 });
  const op = found.value;
  const wasUndo = op.undoOf !== null;
  const rows = op.rows.filter((r) => r.outcome === "ok");
  const left = op.rows.filter((r) => r.outcome !== "ok");
  // Only the person who ran it may undo it (`undoFleetOp`), whoever may read it.
  const canUndo =
    op.reversible && op.undoneBy === null && !wasUndo && op.actorId === user.id;
  const rendering = performance.now();
  const body = html`<h1>${wasUndo ? "Brought back" : "Archived"}</h1>
    <p id="home-archived" role="status">
      ${rows.length} app${rows.length === 1 ? "" : "s"}
      ${wasUndo ? "back on the home" : "archived"}${left.length === 0
        ? ""
        : `, ${left.length} left as they were`}.
    </p>
    <ul class="list">
      ${rows.map((r) => html`<li class="row">${r.label}</li>`)}
    </ul>
    ${left.length === 0
      ? null
      : html`<ul class="list muted">
          ${left.map((r) => html`<li class="row">${r.label}: ${r.reason}</li>`)}
        </ul>`}
    <div class="bar mt">
      ${canUndo
        ? html`<form method="post" action="/home/archived/${op.id}/undo">
            ${btn("Undo", { variant: "primary" })}
          </form>`
        : null}
      ${btn("Home", { href: "/" })}
    </div>
    ${canUndo ? html`<p class="small muted">Undo is kept for a day.</p>` : null}`;
  const response = page({ ctx, title: wasUndo ? "Brought back" : "Archived", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /home/archived/:op/undo — the operation's own undo.
export async function homeArchiveUndo(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const undone = await undoFleetOp(ctx.app, ctx.auth.user, ctx.params.op ?? "");
  if (!undone.ok && undone.error.code === "not_found")
    return new Response("not found", { status: 404 });
  if (!undone.ok)
    return redirect("/", {
      url: ctx.url,
      forgeUrl: ctx.app.config.url,
      flash: { tone: "danger", message: undone.error.message },
    });
  return redirect(`/home/archived/${undone.value.id}`);
}
