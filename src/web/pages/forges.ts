/**
 * `/forges`: the client list (#776), every forge this one sent. The path:
 * the owner, from "+ New forge" or the palette, wants to know how the forges
 * they sent are doing — for whom each is, which apps it was given, whether
 * its person has claimed it, and when anything last happened there. Each
 * row opens the child itself; the claim link is never kept, so never shown.
 */

import type { Ctx } from "../../http/context.ts";
import { ATTENTION_WORDS, firstScreenOf, CLAIM_WORDS, claimState, servedRows, dropServed, creditWords, graceWords, runningWords, spendWords, type ClientRow } from "../../spawn/clients.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { undoable } from "../../spawn/claim.ts";
import { changeDoor, reissueDoor } from "../../spawn/door.ts";
import { readForm } from "../form.ts";
import { badge, btn, row, time } from "../ui.ts";
import { noRoom } from "../../spawn/door.ts";
import { sizeWords, useWords } from "../../spawn/usage.ts";
import { diskWords } from "../../spawn/disk_mount.ts";
import { listChildren } from "../../actions/spawn.ts";
import { ownCode, removeForge, stopForge, type Managed } from "../../spawn/manage.ts";
import { readOwnCode } from "../../spawn/own_code.ts";
import { countRefusals, mayReadRefusals } from "../../core/first_ask_refusals.ts";
import { claimLinkBody } from "./new-forge.ts";
import { appLinkWords } from "../../spawn/app_links.ts";


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

export function forgeRow(r: ClientRow, now: number): Html {
  const state = claimState(r);
  const meta = [
    r.for === null ? null : html`for ${r.for}`,
    r.apps.length === 0 ? null : html`${r.apps.join(", ")}`,
    state === "unknown" ? html`it did not answer just now` : null,
    r.made ? badge(r.awake === true ? "awake" : "asleep", r.awake === true ? { tone: "success" } : { variant: "outline" }) : null,
    r.made ? html`${sizeWords(r.size)}` : null,
    r.made ? html`<span data-disk="${r.disk.own ? "own" : "shared"}">${diskWords(r.disk)}</span>` : null,
    runningNote(r),
    spendNote(r),
    creditWords(r) === null ? null : html`<span data-credit>${creditWords(r)}</span>`,
    graceWords(r) === null ? null : html`<span data-grace>${graceWords(r)}</span>`,
    r.stage === null
      ? null
      : html`<span data-stage="${r.stage.key}"${r.stage.resend ? html` data-resend` : null}>${r.stage.words}${r.stage.at === null ? null : html` ${time(r.stage.at)}`}</span>`,
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
    // Enter opens the row's first link, the forge's name.
    nav: true,
    data: { forge: r.name, claimed: state },
    children: [
      ...(firstScreenOf(r) === null ? [] : [row({ title: html`${firstScreenOf(r)}`, data: { "first-screen": "" } })]),
      // Each app it was sent, and whether it still follows it: its owner may have severed.
      ...(r.appLinks ?? []).map((l) => row({ title: html`${appLinkWords(l)}`, data: { "app-link": l.state } })),
      ...(r.reach?.proofs ?? []).map((p) =>
        // One row per public address; the word in the trail, not a colour, says which failed.
        row({
          title: html`<a href="${p.url}">${p.url.replace(/^https?:\/\//, "")}</a>`,
          meta: html`${p.says}`,
          trail: badge(p.ok ? "reachable" : "not reachable", p.ok ? { tone: "success" as const } : { tone: "attn" as const }),
          data: { proof: p.ok ? "ok" : "failed" },
        }),
      ),
    ],
    trail: html`${r.attention === null
        ? null
        : html`<span data-attention="${r.attention}">${badge(ATTENTION_WORDS[r.attention], { tone: "attn" })}</span>`}${badge(CLAIM_WORDS[state], {
        ...(state === "yes" ? { tone: "success" as const } : { variant: "outline" as const }),
      })}${state === "no"
        ? html`<form method="post" action="/forges/${r.name}/claim-link">
            ${btn(r.stage?.resend === true ? "Resend" : "Send a fresh link", { size: "sm", title: "A new claim link; the old one stops working" })}
          </form>`
        : null}${r.link === null
        ? null
        : html`<span data-link="${r.link.state}">${badge(LINK_WORDS[r.link.state], { variant: "outline" as const })}</span>${r.link.state === "open"
            ? html`<form method="post" action="/forges/${r.name}/revoke-link" class="inline">${btn("Revoke", { size: "sm", title: "End this link now; you can undo for a minute" })}</form>`
            : undoable(r.link, now)
              ? html`<form method="post" action="/forges/${r.name}/undo-link" class="inline">${btn("Undo", { size: "sm", title: "Bring the link back; possible for a minute after it ended" })}</form>`
              : null}`}${r.made
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

/** The link to the refused first asks, only when there are any, with their count; it shares the paragraph of the other link so the page gains no block. */
function refusedLink(ctx: Ctx): Html | null {
  if (!mayReadRefusals(ctx.auth.user)) return null;
  const n = countRefusals(ctx.app.db, Date.now());
  return n === 0 ? null : html` <a href="/forges/refused">Refused first asks (${n})</a>`;
}

// GET /forges — an admin's only.
export async function forgesPage(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user?.isAdmin) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rows = await timePhaseAsync(ctx.request, "clients", () => servedRows(ctx.app));
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
        sub: "Each forge you sent: who it is for and what runs there.",
        actions: action,
      })}
      ${receipt(ctx, rows)}
      ${rows.length === 0
        ? html`<section class="settings-block">
            <h2>No forges sent yet</h2>
            <p>${action}</p>
          </section>`
        : html`<section class="settings-block" id="forges-compare">
              <h2>Side by side</h2>
              ${sideBySide(rows)}
            </section>
            <section class="settings-block">
              <h2>Forges</h2>
              <ul class="list setting-list">
                ${rows.map((r) => forgeRow(r, Date.now()))}
              </ul>
            </section>`}
      ${await ownCodeSection(ctx)}
      <p class="mt"><a href="/fleet/graph">Fleet graph</a>${refusedLink(ctx)}</p>
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
        <section class="settings-block">
          ${typeof link === "string"
            ? claimLinkBody(link, true)
            : html`<p>${String(door.body["message"] ?? "")}</p>
                <p class="mt">${btn("Forges you sent", { href: "/forges", size: "sm" })}</p>`}
        </section>
      </div>`,
    },
    door.status,
  );
  response.headers.set("cache-control", "no-store");
  return response;
}

const LINK_WORDS = { open: "Link open", used: "Link used", ended: "Link ended" } as const;

/** What `/forges?link=…&forge=…` says after a revoke or undo: fixed words, and only for a forge in the list. */
function receipt(ctx: Ctx, rows: readonly ClientRow[]): Html | null {
  const name = ctx.url.searchParams.get("forge") ?? "";
  if (!rows.some((r) => r.name === name)) return null;
  const says = {
    revoked: html`The link for <strong>${name}</strong> has ended. Undo is beside it for a minute.`,
    restored: html`The link for <strong>${name}</strong> is open again.`,
    refused: html`The link for <strong>${name}</strong> did not change: it was not open, or the minute is over.`,
  }[ctx.url.searchParams.get("link") ?? ""];
  return says === undefined ? null : html`<p role="status" class="muted" data-receipt>${says}</p>`;
}

// POST /forges/:name/revoke-link and /undo-link — take the link back, or bring it back for a minute; then the row, with a receipt.
function linkChange(act: "revoke" | "undo") {
  return async (ctx: Ctx): Promise<Response> => {
    const user = ctx.auth.user;
    if (!user?.isAdmin) return notFoundPage(ctx);
    const form = await readForm(ctx, "admin");
    if (form instanceof Response) return form;
    const name = ctx.params["name"] ?? "";
    const door = await changeDoor(ctx, user, name, act);
    if (door.status === 404) return notFoundPage(ctx);
    const link = door.status >= 400 ? "refused" : act === "revoke" ? "revoked" : "restored";
    return redirect(`/forges?link=${link}&forge=${encodeURIComponent(name)}`);
  };
}
export const forgeLinkRevoke = linkChange("revoke");
export const forgeLinkUndo = linkChange("undo");

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
          <section class="settings-block">
            <p role="status">${done.says}</p>
            <p class="mt">${btn("Back to your forges", { href: "/forges", size: "sm" })}</p>
          </section>
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
      <section class="settings-block">
        <h2>What removing deletes</h2>
        <p>This deletes the forge <strong>${name}</strong> at ${child.url.replace(/^https?:\/\//, "")} with everything in it: its repositories, issues, accounts and settings. It cannot be undone.</p>
        <form method="post" action="/forges/${name}/remove" class="mt">
          ${btn("Remove it for good", { variant: "primary" })}
          ${btn("Keep it", { href: "/forges" })}
        </form>
      </section>
    </div>`,
  });
  response.headers.set("cache-control", "no-store");
  return response;
}

const CODE_WORDS = {
  on: "will run its own code from its next start.",
  off: "will run this forge's code from its next start.",
  refused: "stays on this forge's code: only a forge in its own cell, with a forge repository, can run its own.",
} as const;

/** What `/forges?code=…&forge=…` says after the switch: fixed words, and only for a forge in the list. */
function codeReceipt(ctx: Ctx, names: readonly string[]): Html | null {
  const name = ctx.url.searchParams.get("forge") ?? "";
  const code = ctx.url.searchParams.get("code") ?? "";
  if (!names.includes(name) || !(code in CODE_WORDS)) return null;
  return html`<p role="status" class="muted" data-receipt>${name} ${CODE_WORDS[code as keyof typeof CODE_WORDS]}</p>`;
}

/** Each forge's code, one row each: whose code it runs, the switch, and the last rollback. */
async function ownCodeSection(ctx: Ctx): Promise<Html | null> {
  const children = (await listChildren(ctx.app)).filter((c) => c.done);
  if (children.length === 0) return null;
  return html`<section class="settings-block" id="forge-code">
    <h2>Forge code</h2>
    ${codeReceipt(ctx, children.map((c) => c.name))}
    <dl class="status-rows">
      ${children.map((c) => {
        const own = readOwnCode(ctx.app, c.name);
        const rb = own.rolledBack;
        const state = html`${own.on ? "Its own code" : "This forge's code"}${rb === undefined
          ? null
          : html`<br /><span data-rolled-back>${badge("Rolled back", { tone: "attn" })} ${time(rb.at)}${rb.commit === "" ? null : html` from ${rb.commit}`}: ${rb.why}. Ran ${rb.to === "last-good" ? "its last good commit" : "this forge's code"}.</span>`}`;
        const action =
          c.placement === "cell"
            ? html`<form method="post" action="/forges/${c.name}/own-code" class="inline">
                <input type="hidden" name="on" value="${own.on ? "off" : "on"}" />
                ${btn(own.on ? "Use this forge's code" : "Use its own code", { size: "sm", variant: "ghost" })}
              </form>`
            : html`<span class="muted small">Shares this forge's process</span>`;
        return html`<div class="status-row" data-own-code="${own.on ? "on" : "off"}">
          <dt>${c.name}</dt>
          <dd>${state}</dd>
          <dd class="status-act">${action}</dd>
        </div>`;
      })}
    </dl>
  </section>`;
}

// POST /forges/:name/own-code — the owner's switch: `on` is "on" or "off"; then back to the list, with a receipt.
export async function forgeOwnCodeSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user?.isAdmin) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const want = form.get("on");
  if (want !== "on" && want !== "off") return notFoundPage(ctx);
  const name = ctx.params["name"] ?? "";
  const done = await ownCode(ctx.app, name, want === "on");
  dropServed(ctx.app);
  return redirect(`/forges?code=${done.ok ? want : "refused"}&forge=${encodeURIComponent(name)}#forge-code`);
}
