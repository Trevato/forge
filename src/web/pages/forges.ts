/**
 * `/forges`: the client list (#776), every forge this one sent. The path:
 * the owner, from "+ New forge" or the palette, wants to know how the forges
 * they sent are doing — for whom each is, which apps it was given, whether
 * its person has claimed it, and when anything last happened there. Each
 * row opens the child itself; the claim link is never kept, so never shown.
 */

import type { Ctx } from "../../http/context.ts";
import { CLAIM_WORDS, claimState, clientRows, runningWords, type ClientRow } from "../../spawn/clients.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { reissueDoor } from "../../spawn/door.ts";
import { readForm } from "../form.ts";
import { badge, btn, card, empty, row, time } from "../ui.ts";
import { noRoom } from "../../spawn/door.ts";
import { claimLinkBody } from "./new-forge.ts";


/** "3 apps running", or which one is not and why. */
function runningNote(r: ClientRow): Html | null {
  const words = runningWords(r);
  if (words === null) return null;
  return html`<span data-apps="${r.running!.notRunning.length === 0 ? "up" : "down"}"
    >${words}</span
  >`;
}

function forgeRow(r: ClientRow): Html {
  const state = claimState(r);
  const meta = [
    state === "unknown" ? html`it did not answer just now` : null,
    r.for === null ? null : html`for ${r.for}`,
    r.apps.length === 0 ? null : html`${r.apps.join(", ")}`,
    runningNote(r),
    r.sentAt === null ? null : html`sent ${time(r.sentAt)}`,
    r.lastActivityAt === null
      ? null
      : html`last activity ${time(r.lastActivityAt)}`,
  ].filter((m): m is Html => m !== null);
  return row({
    title: html`<a href="${r.url}">${r.name}</a>`,
    meta: html`${meta.map((m, i) => html`${i > 0 ? " · " : ""}${m}`)}`,
    data: { forge: r.name, claimed: state },
    trail: html`${badge(CLAIM_WORDS[state], {
        ...(state === "yes" ? { tone: "success" as const } : { variant: "outline" as const }),
      })}${state === "no"
        ? html`<form method="post" action="/forges/${r.name}/claim-link">
            ${btn("Send a fresh link", { size: "sm", title: "A new claim link; the old one stops working" })}
          </form>`
        : null}`,
  });
}

// GET /forges — an admin's only.
export async function forgesPage(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user?.isAdmin) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rows = await timePhaseAsync(ctx.request, "clients", () => clientRows(ctx.app));
  const full = timePhase(ctx.request, "room", () => noRoom(ctx.app));
  const rendering = performance.now();
  const action =
    full === undefined
      ? btn("New forge", { href: "/forges/new", variant: "primary", size: "sm" })
      : html`<button type="button" class="btn" data-variant="primary" data-size="sm" disabled title="${full}">New forge</button>
          <p class="muted small" role="status">${full}</p>`;
  const response = page({
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
            html`<ul class="list setting-list">
              ${rows.map(forgeRow)}
            </ul>`,
            { pad: false },
          )}
      <p class="mt"><a href="/fleet/graph">Fleet graph</a></p>
    </div>`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
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
