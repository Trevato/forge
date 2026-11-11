/**
 * Settings › Captain (#11011), for the forge's owner: what Talk remembers
 * (the standing rules loaded into every session, editable here) and the
 * routines that post into the Captain thread, each with its schedule. Plain
 * forms, so it works without the script; every change is the signed-in
 * browser's own, same-origin, admin only.
 */

import { addMemory, editMemory, MEMORY_TEXT_MAX, MEMORY_WORDS, removeMemory, rulesOf } from "../../core/talk_memory.ts";
import { EVERY_MAX, EVERY_MIN, listRoutines, ROUTINE_KINDS, ROUTINE_NAMES, setRoutine } from "../../core/talk_routines.ts";
import { runRoutine } from "../../crew/routines.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { forbiddenPage, notFoundPage, pageHead, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, field as uiField } from "../ui.ts";
import { accountSections } from "./origins.ts";

const BACK = "/settings/captain";

function requireOwner(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin || ctx.auth.user.kind !== "user") return notFoundPage(ctx);
  return undefined;
}

const when = (iso: string | null): string => (iso === null ? "not yet" : iso.slice(0, 16).replace("T", " ") + " UTC");

function view(ctx: Ctx, error?: string, status = 200): Response {
  const user = ctx.auth.user!;
  const memory = rulesOf(ctx.app.db, user.id);
  const routines = listRoutines(ctx.app.db, user.id);
  const body: Html = html`<section class="settings-block">
    <h2>Memory</h2>
    ${error ? html`<p class="field-error" role="alert">${error}</p>` : null}
    <ul class="list">${memory.map((m) => html`<li class="row">
      <form method="post" action="${BACK}" class="row-main">
        <input type="hidden" name="id" value="${m.id}">
        ${uiField({ label: "Rule", name: "text", value: m.text, maxlength: MEMORY_TEXT_MAX, id: `m-${m.id}` })}
        <div class="form-actions">${btn("Save", { name: "do", value: "edit" })}${btn("Delete", { name: "do", value: "delete" })}</div>
      </form>
    </li>`)}</ul>
    <form method="post" action="${BACK}">
      <input type="hidden" name="do" value="add">
      ${uiField({ label: "Remember", name: "text", maxlength: MEMORY_TEXT_MAX, placeholder: "Never merge on a Friday without asking.", id: "m-new" })}
      <div class="form-actions">${btn("Add", { variant: "primary" })}</div>
    </form>
  </section>
  <section class="settings-block">
    <h2>Routines</h2>
    <ul class="list">${routines.map((r) => html`<li class="row">
      <form method="post" action="${BACK}" class="row-main">
        <input type="hidden" name="kind" value="${r.kind}">
        ${uiField({ label: ROUTINE_NAMES[r.kind], name: "enabled", type: "checkbox", value: "1", checked: r.enabled, id: `on-${r.kind}` })}
        ${uiField({ label: "Every (minutes)", name: "every", type: "number", value: String(r.everyMin), min: EVERY_MIN, max: EVERY_MAX, id: `ev-${r.kind}` })}
        ${uiField({ label: "Daily at hour (UTC)", name: "hour", type: "number", value: r.atHour === null ? "" : String(r.atHour), min: 0, max: 23, id: `hr-${r.kind}` })}
        <span class="muted small">Last posted: ${when(r.lastAt)}${r.conversationId === null ? "" : html` · <a href="/talk/${r.conversationId}">thread</a>`}</span>
        <div class="form-actions">${btn("Save", { variant: "primary", name: "do", value: "routine" })}${btn("Post now", { name: "do", value: "run" })}</div>
      </form>
    </li>`)}</ul>
  </section>`;
  const rendering = performance.now();
  const response = page(
    {
      ctx,
      title: "Captain",
      body: html`${pageHead("Captain", { sub: "What Talk remembers about how you want the forge run, and the check-ins it posts for you." })}${settingsLayout(accountSections("captain", { admin: true }), body, "Account settings")}`,
    },
    status,
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// GET /settings/captain
export function captainPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return requireOwner(ctx) ?? view(ctx);
}


// POST /settings/captain
export async function captainAct(ctx: Ctx): Promise<Response> {
  const denied = requireOwner(ctx);
  if (denied) return denied;
  const user = ctx.auth.user!;
  if (ctx.auth.via !== "session") return forbiddenPage(ctx, "Change this from your own signed-in browser.");
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const what = field(form, "do");
  const db = ctx.app.db;
  if (what === "add" || what === "edit") {
    const saved = what === "add" ? addMemory(db, user.id, field(form, "text")) : editMemory(db, user.id, field(form, "id"), field(form, "text"));
    return saved.ok ? flashTo(ctx, BACK, { message: what === "add" ? "Remembered." : "Saved." }) : view(ctx, MEMORY_WORDS[saved.error], 422);
  }
  if (what === "delete") {
    const gone = removeMemory(db, user.id, field(form, "id"));
    return gone.ok ? flashTo(ctx, BACK, { message: "Forgotten." }) : view(ctx, MEMORY_WORDS.not_found, 404);
  }
  if (what === "routine" || what === "run") {
    const kind = field(form, "kind");
    if (what === "run") {
      if (!(ROUTINE_KINDS as readonly string[]).includes(kind)) return view(ctx, "That is not a routine.", 422);
      const posted = await runRoutine(ctx.app, user, kind as (typeof ROUTINE_KINDS)[number], new Date());
      return flashTo(ctx, `/talk/${posted.conversationId}`, { message: "Posted." });
    }
    const hour = field(form, "hour").trim();
    const saved = setRoutine(db, user.id, kind, { enabled: field(form, "enabled") === "1", everyMin: Number(field(form, "every")), atHour: hour === "" ? null : Number(hour) });
    if (!saved.ok) return view(ctx, { not_a_routine: "That is not a routine.", bad_every: `Every must be ${EVERY_MIN} to ${EVERY_MAX} minutes.`, bad_hour: "The hour is 0 to 23." }[saved.error], 422);
    return flashTo(ctx, BACK, { message: `${ROUTINE_NAMES[saved.value.kind]} saved.` });
  }
  return view(ctx, "Nothing to do.", 422);
}
