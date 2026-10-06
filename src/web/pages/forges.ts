/**
 * `/forges`: the client list (#776), every forge this one sent. The path:
 * the owner, from "+ New forge" or the palette, wants to know how the forges
 * they sent are doing — for whom each is, which apps it was given, whether
 * its person has claimed it, and when anything last happened there. Each
 * row opens the child itself; the claim link is never kept, so never shown.
 */

import type { Ctx } from "../../http/context.ts";
import { clientRows, type ClientRow } from "../../spawn/clients.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, card, empty, time } from "../ui.ts";

const STATE: Record<"yes" | "no" | "unknown" | "making", string> = {
  yes: "Claimed",
  no: "Not claimed yet",
  unknown: "Unknown",
  making: "Still being made",
};

function stateOf(r: ClientRow): keyof typeof STATE {
  if (!r.made) return "making";
  return r.claimed === null ? "unknown" : r.claimed ? "yes" : "no";
}

function forgeRow(r: ClientRow): Html {
  const state = stateOf(r);
  const meta = [
    r.for === null ? null : html`for ${r.for}`,
    r.apps.length === 0 ? null : html`${r.apps.join(", ")}`,
    r.sentAt === null ? null : html`sent ${time(r.sentAt)}`,
    r.lastActivityAt === null
      ? null
      : html`last activity ${time(r.lastActivityAt)}`,
  ].filter((m): m is Html => m !== null);
  return html`<li data-forge="${r.name}" data-claimed="${state}">
    <a class="row" href="${r.url}">
      <span class="row-main">
        <span class="row-title">${r.name}</span>
        <span class="row-meta"
          >${meta.map((m, i) => html`${i > 0 ? " · " : ""}${m}`)}</span
        >
      </span>
      <span class="row-trail"
        ><span
          class="pill"
          ${state === "unknown" ? html`title="It did not answer just now"` : null}
          ${state === "yes" ? html`data-tone="accent"` : null}
          >${STATE[state]}</span
        ></span
      >
    </a>
  </li>`;
}

// GET /forges — an admin's only.
export async function forgesPage(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user?.isAdmin) return notFoundPage(ctx);
  const rows = await clientRows(ctx.app);
  const action = btn("New forge", {
    href: "/forges/new",
    variant: "primary",
    size: "sm",
  });
  return page({
    ctx,
    title: "Forges you sent",
    body: html`<div class="narrow-wide">
      ${pageHead("Forges you sent", {
        sub: "For whom each is, what it was given, and whether its person has claimed it.",
        actions: action,
      })}
      ${rows.length === 0
        ? empty({
            icon: "fork",
            title: "No forges sent yet",
            note: "A whole forge for someone: the apps you choose, a crew, and one link to send.",
            action,
          })
        : card(
            html`<ul class="list forges-sent">
              ${rows.map(forgeRow)}
            </ul>`,
            { pad: false },
          )}
    </div>`,
  });
}
