/**
 * Settings → Confirms (#7650): what the forge's agent asked to do and is
 * waiting for your yes — one sentence each, with a Yes button. The yes is
 * a same-origin form POST from your own session (`readForm`), and does the
 * stored call once (`actions/conversation_confirms.ts`). A result shown only
 * once (an invite link, a claim link, a credential) is rendered on the
 * answer itself, never put in a flash cookie or the conversation.
 */

import { REFUSED, sayYes, waitingConfirms } from "../../actions/conversation_confirms.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { ASKING } from "../../crew/conversation_confirm.ts";
import type { Ctx } from "../../http/context.ts";
import { settingsLayout, signInFirst, forbiddenPage } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, icon, messageText, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

const BACK = "/settings/confirms";

function confirmsPage(ctx: Ctx, shown?: Html): Response {
  const user = ctx.auth.user!;
  const waiting = waitingConfirms(ctx, user);
  const body = html`<p class="muted small mb">
      What the forge's agent asked to do in your conversation and has not
      done: an outward-facing or hard-to-undo action waits here for your yes,
      ten minutes at most. A yes does it once, as you.
    </p>
    ${shown ?? null}
    <section class="settings-block" id="waiting">
      <h2>Waiting for your yes</h2>
      ${waiting.length === 0
        ? html`<p class="muted">Nothing waiting: when the agent asks before acting, it shows here.</p>`
        : html`<ul class="list setting-list" id="confirms-list">
            ${waiting.map((w) =>
              row({
                lead: icon("chevronRight"),
                title: w.does,
                meta: html`asked ${time(w.createdAt)} · until ${time(w.expiresAt)} · full arguments`,
                // The row folds open on every argument as the call will run; the yes sits beside it.
                fold: { id: `confirm-${w.id}`, open: false, body: html`<div class="confirm-args">${messageText(w.arguments)}</div>` },
                after: html`<form class="row-actions" method="post" action="${BACK}/${w.id}">
                  ${btn("Yes", { variant: "primary", size: "sm", icon: "check", label: `Yes: ${w.tool}` })}
                </form>`,
              }),
            )}
          </ul>`}
    </section>`;
  return page({
    ctx,
    title: "Confirms",
    body: html`<div class="page-head"><h1>Confirms</h1></div>
      ${settingsLayout(accountSections("confirms", { admin: user.isAdmin }), body, "Account settings")}`,
  });
}

// GET /settings/confirms
export function confirmsList(ctx: Ctx): Response {
  if (ctx.auth.user === undefined) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return timePhase(ctx.request, "render", () => confirmsPage(ctx));
}

// POST /settings/confirms/:id — the person's yes.
export async function confirmYes(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  // A browser's own session, as the API's door: never a token or a password.
  if (ctx.auth.via !== "session") return forbiddenPage(ctx, "Answer this from your own signed-in browser.");
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const yes = await sayYes(ctx, user, ctx.params["id"] ?? "");
  if (!yes.ok) return flashTo(ctx, BACK, { tone: "danger", message: `Nothing was done: ${REFUSED[yes.error][1]}.` });
  const tool = String(yes.turn["tool"]);
  const undo = typeof yes.turn["undo"] === "string" ? ` To undo: ${yes.turn["undo"]}.` : "";
  if (!yes.done)
    return flashTo(ctx, BACK, { tone: "danger", message: `${tool} did not go through: ${String(yes.turn["message"] ?? yes.turn["error"])}` });
  if (ASKING[tool]?.once === undefined) return flashTo(ctx, BACK, { tone: "success", message: `Done: ${tool}.${undo}` });
  return confirmsPage(
    ctx,
    html`<section class="settings-block" id="done">
      <h2>Done: ${tool}</h2>
      <p class="muted small">Shown this once; copy it now. It is not kept in the conversation.</p>
      <pre class="mono">${JSON.stringify(yes.result, null, 2)}</pre>
    </section>`,
  );
}
