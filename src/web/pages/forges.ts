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
import { reissueDoor } from "../../spawn/door.ts";
import { readForm } from "../form.ts";
import { btn, card, empty, time } from "../ui.ts";
import { claimLinkBody } from "./new-forge.ts";

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
    <div class="row">
      <span class="row-main">
        <a class="row-title" href="${r.url}">${r.name}</a>
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
        >${state === "no"
          ? html`<form method="post" action="/forges/${r.name}/claim-link">
              ${btn("Send a fresh link", { size: "sm", title: "A new claim link; the old one stops working" })}
            </form>`
          : null}</span
      >
    </div>
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

// POST /forges/:name/claim-link — a fresh link for an unclaimed child; the
// old one stops working. Shown once, in this answer only.
export async function forgeLinkSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user?.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const name = ctx.params["name"] ?? "";
  const door = await reissueDoor(ctx, user, name);
  const link = door.body["claimUrl"];
  const response = page(
    {
      ctx,
      title: "A fresh link",
      body: html`<div class="narrow-wide">
        ${pageHead(typeof link === "string" ? `A fresh link for ${name}` : `No fresh link for ${name}`)}
        ${card(
          typeof link === "string"
            ? claimLinkBody(link)
            : html`<p>${String(door.body["message"] ?? "")}</p>
                <p class="mt">${btn("Forges you sent", { href: "/forges", size: "sm" })}</p>`,
        )}
      </div>`,
    },
    door.status,
  );
  response.headers.set("cache-control", "no-store");
  return response;
}
