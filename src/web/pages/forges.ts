/**
 * `/forges`: the client list (#776), every forge this one sent. The path:
 * the owner, from "+ New forge" or the palette, wants to know how the forges
 * they sent are doing — for whom each is, which apps it was given, whether
 * its person has claimed it, and when anything last happened there. Each
 * row opens the child itself; the claim link is never kept, so never shown.
 */

import type { Ctx } from "../../http/context.ts";
import { ATTENTION_WORDS, CLAIM_WORDS, claimState, clientRows, runningWords, spendWords, type ClientRow } from "../../spawn/clients.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { reissueDoor } from "../../spawn/door.ts";
import { readForm } from "../form.ts";
import { badge, btn, card, empty, row, time } from "../ui.ts";
import { noRoom } from "../../spawn/door.ts";
import { sizeWords, useWords } from "../../spawn/usage.ts";
import { listChildren } from "../../actions/spawn.ts";
import { removeForge, stopForge, type Managed } from "../../spawn/manage.ts";
import { claimLinkBody } from "./new-forge.ts";


/** "3 apps running", or which one is not and why. */
function runningNote(r: ClientRow): Html | null {
  const words = runningWords(r);
  if (words === null) return null;
  const down = (r.running?.notRunning.length ?? 0) > 0 || r.reach?.ok === false;
  return html`<span data-apps="${down ? "down" : "up"}"
    >${words}</span
  >`;
}

/** The crew's spend today against its cap; attention-toned from 80%. */
function spendNote(r: ClientRow): Html | null {
  const s = spendWords(r);
  if (s === null) return null;
  return s.warn
    ? html`<span data-spend="warn">${badge(s.words, { tone: "attn" })}</span>`
    : html`<span data-spend="ok">${s.words}</span>`;
}

function forgeRow(r: ClientRow): Html {
  const state = claimState(r);
  const meta = [
    state === "unknown" ? html`it did not answer just now` : null,
    r.made ? badge(r.awake === true ? "awake" : "asleep", r.awake === true ? { tone: "success" } : { variant: "outline" }) : null,
    r.made ? html`${sizeWords(r.size)}` : null,
    r.for === null ? null : html`for ${r.for}`,
    r.apps.length === 0 ? null : html`${r.apps.join(", ")}`,
    runningNote(r),
    spendNote(r),
    r.sentAt === null ? null : html`sent ${time(r.sentAt)}`,
    r.lastActivityAt === null
      ? null
      : html`last activity ${time(r.lastActivityAt)}`,
    badge(r.nextStep.key === "going" ? html`going: last tell ${time(r.nextStep.lastTellAt!)}` : r.nextStep.words, {
      variant: "outline",
    }),
  ].filter((m): m is Html => m !== null);
  return row({
    title: html`<a href="${r.url}">${r.name}</a>`,
    meta: html`${meta.map((m, i) => html`${i > 0 ? " · " : ""}${m}`)}`,
    data: { forge: r.name, claimed: state },
    ...(r.reach === null
      ? {}
      : {
          // One row per public address; the word in the trail, not a colour, says which failed.
          children: r.reach.proofs.map((p) =>
            row({
              title: html`<a href="${p.url}">${p.url.replace(/^https?:\/\//, "")}</a>`,
              meta: html`${p.says}`,
              trail: badge(p.ok ? "reachable" : "not reachable", p.ok ? { tone: "success" as const } : { tone: "attn" as const }),
              data: { proof: p.ok ? "ok" : "failed" },
            }),
          ),
        }),
    trail: html`${r.attention === null
        ? null
        : html`<span data-attention="${r.attention}">${badge(ATTENTION_WORDS[r.attention], { tone: "attn" })}</span>`}${badge(CLAIM_WORDS[state], {
        ...(state === "yes" ? { tone: "success" as const } : { variant: "outline" as const }),
      })}${state === "no"
        ? html`<form method="post" action="/forges/${r.name}/claim-link">
            ${btn("Send a fresh link", { size: "sm", title: "A new claim link; the old one stops working" })}
          </form>`
        : null}${r.made
        ? html`<form method="post" action="/forges/${r.name}/stop" class="inline">${btn("Stop", { size: "sm", title: "Put it to sleep now; its next visitor wakes it" })}</form>
          ${btn("Remove", { href: `/forges/${r.name}/remove`, size: "sm", title: "Asks first, then deletes this forge and its data for good" })}`
        : null}`,
  });
}

/** The forges side by side: one row each, the same columns, so none shifts. */
export function sideBySide(rows: readonly ClientRow[]): Html {
  return html`<div class="table-scroll" role="region" tabindex="0" aria-label="Forges side by side">
    <table class="table" data-dense data-sticky-lead data-by="forges">
      <thead>
        <tr>
          <th scope="col">Forge</th>
          <th scope="col">Address</th>
          <th scope="col">Size</th>
          <th scope="col">Memory</th>
          <th scope="col">CPU</th>
          <th scope="col">Disk</th>
          <th scope="col">Apps</th>
          <th scope="col">Last heartbeat</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => {
          const use = useWords(r.use);
          return html`<tr data-compare="${r.name}" data-use="${r.use.kind}">
            <th scope="row">${r.name}</th>
            <td><a href="${r.url}">${r.url.replace(/^https?:\/\//, "")}</a></td>
            <td>${sizeWords(r.size)}</td>
            <td>${use.memory}</td>
            <td>${use.cpu}</td>
            <td>${use.disk}</td>
            <td>${r.apps.length === 0 ? "none" : r.apps.join(", ")}</td>
            <td>${r.lastHeartbeatAt === null ? "none yet" : time(r.lastHeartbeatAt)}</td>
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;
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
    body: html`<div class="narrow-wide" data-forges>
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
        : card(sideBySide(rows), { pad: false, id: "forges-compare" })}
      ${rows.length === 0
        ? null
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
      body: html`<div class="narrow-wide" data-forges>
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

// POST /forges/:name/stop and /remove — the owner's hands on a hosted forge.
function manageSubmit(act: (app: Ctx["app"], name: string) => Promise<Managed>, title: string) {
  return async (ctx: Ctx): Promise<Response> => {
    const user = ctx.auth.user;
    if (!user?.isAdmin) return notFoundPage(ctx);
    const form = await readForm(ctx, "admin");
    if (form instanceof Response) return form;
    const done = await act(ctx.app, ctx.params["name"] ?? "");
    const response = page(
      {
        ctx,
        title,
        body: html`<div class="narrow-wide" data-forges>
          ${pageHead(title)}
          ${card(html`<p role="status">${done.says}</p><p class="mt">${btn("Back to your forges", { href: "/forges", size: "sm" })}</p>`)}
        </div>`,
      },
      done.ok ? 200 : 404,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  };
}
export const forgeStopSubmit = manageSubmit(stopForge, "Forge stopped");
export const forgeRemoveSubmit = manageSubmit(removeForge, "Forge removed");

// GET /forges/:name/remove — what removing would delete, and the one button that does it.
export async function forgeRemoveConfirm(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user?.isAdmin) return notFoundPage(ctx);
  const name = ctx.params["name"] ?? "";
  const child = (await listChildren(ctx.app)).find((c) => c.name === name);
  if (child === undefined) return notFoundPage(ctx);
  const response = page({
    ctx,
    title: `Remove ${name}?`,
    body: html`<div class="narrow-wide" data-forges>
      ${pageHead(`Remove ${name}?`)}
      ${card(html`<p>This deletes the forge <strong>${name}</strong> at ${child.url.replace(/^https?:\/\//, "")} with everything in it: its repositories, issues, accounts and settings. It cannot be undone.</p>
        <form method="post" action="/forges/${name}/remove" class="mt">
          ${btn("Remove it for good", { variant: "primary" })}
          ${btn("Keep it", { href: "/forges" })}
        </form>`)}
    </div>`,
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
