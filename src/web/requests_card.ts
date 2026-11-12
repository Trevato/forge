/**
 * The Waiting list: strangers who asked for an account (#10928), each with
 * the note they left, when, and from where, and Allow and Decline one tap
 * apart. Shown on top of the accounts page and in home's "Needs you", for a
 * forge admin; both answer through `actions/requests.ts`.
 */

import { allowRequest, declineRequest, listRequests } from "../actions/requests.ts";
import type { Ctx } from "../http/context.ts";
import { notFoundPage, signInFirst } from "./chrome.ts";
import { readForm } from "./form.ts";
import { html, type Html } from "./html.ts";
import { flashTo } from "./layout.ts";
import { btn, row, time } from "./ui.ts";

/** The card, or nothing when nobody waits or the viewer is not an admin. */
export function requestsCard(ctx: Ctx, back = ""): Html | null {
  const listed = listRequests(ctx.app, ctx.auth.user);
  if (!listed.ok || listed.value.length === 0) return null;
  return html`<section class="settings-block" id="waiting" aria-label="Waiting">
    <h2>Waiting <span class="muted">${listed.value.length}</span></h2>
    <ul class="list setting-list">
      ${listed.value.map((r) => {
        const at = `/settings/accounts/${encodeURIComponent(r.username)}`;
        const to = back === "" ? "" : `?back=${back}`;
        return row({
          title: html`<strong>${r.username}</strong>`,
          meta: html`asked ${time(r.askedAt)} · from ${r.source === "" ? "the web" : r.source}${r.note === ""
            ? null
            : html`<br />${r.note}`}`,
          after: html`<form method="post" action="${at}/allow${to}">
              ${btn("Allow", { type: "submit", variant: "primary" })}
            </form>
            <form method="post" action="${at}/decline${to}">
              ${btn("Decline", { type: "submit", variant: "outline" })}
            </form>`,
        });
      })}
    </ul>
  </section>`;
}

/** POST /settings/accounts/:username/allow and /decline. */
export function requestAct(act: "allow" | "decline") {
  return async (ctx: Ctx): Promise<Response> => {
    if (!ctx.auth.user) return signInFirst(ctx);
    if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
    const form = await readForm(ctx, "admin");
    if (form instanceof Response) return form;
    const username = ctx.params.username ?? "";
    const done = (act === "allow" ? allowRequest : declineRequest)(ctx.app, ctx.auth.user, username);
    if (!done.ok && done.error === "not_found") return notFoundPage(ctx);
    const to = ctx.url.searchParams.get("back") === "home" ? "/" : "/settings/accounts";
    return flashTo(ctx, to, {
      message: done.ok
        ? `${username} ${act === "allow" ? "is in" : "was declined, politely"}.`
        : `${username} is not waiting any more.`,
    });
  };
}
