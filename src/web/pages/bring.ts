/**
 * `/bring`: paste the link to an app on another forge, and it runs here.
 *
 * Three small pages, one per step, each working without JavaScript: the link
 * form, the import while it happens (the same checklist a mirror shows), and
 * the landing, which says what the app asks for and takes it in one form.
 * The first deploy is then watched on the app's own page.
 */

import { bringLanded, bringLook, setBroughtEnv, startBring, type BringError } from "../../actions/bring.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { mirrorJobFor } from "../../actions/origins.ts";
import { notFoundPage } from "../chrome.ts";
import { readForm } from "../form.ts";
import type { Flash } from "../flash.ts";
import { html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { mirrorJs } from "../client.ts";
import { btn, card, field, icon } from "../ui.ts";
import type { Ctx } from "../../http/context.ts";
import { accountOnly } from "./origins.ts";
import { stageList } from "./browse.ts";

const NOT_COPIED = ["data", "variables", "secrets"];

function form(ctx: Ctx, value: string, problem?: Flash, status = 200): Response {
  return page(
    {
      ctx,
      title: "Bring an app",
      ...(problem === undefined ? {} : { flash: problem }),
      body: html`<div class="page-head"><h1>Bring an app</h1></div>
        <div class="narrow-wide">
          ${card(
            html`<p class="muted small">
                Paste the link to an app on another forge. It comes across with
                how it builds and runs, and goes live here at its own address.
                Its ${NOT_COPIED.join(", ")} stay behind: you are asked for
                what it needs next.
              </p>
              <form method="post" action="/bring" class="stack">
                ${field({
                  label: "Link to the app",
                  name: "link",
                  type: "url",
                  value,
                  required: true,
                  autofocus: true,
                  maxlength: 300,
                  placeholder: "https://codeberg.org/ana/notes",
                  spellcheck: false,
                })}
                <div class="bar">${btn("Bring it here", { variant: "primary", icon: "download" })}</div>
              </form>`,
            { head: html`${icon("download")}<h2>Bring it here</h2>` },
          )}
        </div>`,
    },
    status,
  );
}

const danger = (message: string, link?: Flash["link"]): Flash => ({
  message,
  tone: "danger",
  ...(link === undefined ? {} : { link }),
});

function refusal(ctx: Ctx, link: string, e: BringError): Response {
  switch (e.kind) {
    case "connect":
      return form(
        ctx,
        link,
        danger(`Sign in to ${e.host} first, then paste the link again.`, {
          href: "/settings/origins",
          label: "connect your account there",
        }),
        400,
      );
    case "invalid":
      return form(ctx, link, danger(e.message), 400);
    case "unverified":
      return form(ctx, link, danger("Verify your email first: an app runs code."), 403);
    case "unauthorized":
      return form(ctx, link, danger("Only a person's own account brings an app."), 403);
  }
}

/** GET /bring */
export function bringPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const rendering = performance.now();
  const response = form(ctx, ctx.url.searchParams.get("link")?.slice(0, 300) ?? "");
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** POST /bring */
export async function bringSubmit(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const data = await readForm(ctx, "admin");
  if (data instanceof Response) return data;
  const raw = data.get("link");
  const link = typeof raw === "string" ? raw : "";
  const started = startBring(ctx.app, ctx.auth.user, link);
  if (!started.ok) return refusal(ctx, link.slice(0, 300), started.error);
  return redirect(`/bring/${started.value.originId}/${started.value.job.id}`);
}

/** GET /bring/:id/:job */
export async function bringJobPage(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const originId = ctx.params.id ?? "";
  const found = mirrorJobFor(ctx.app, ctx.auth.user, originId, ctx.params.job ?? "");
  if (!found.ok) return notFoundPage(ctx);
  const job = found.value;
  const here = `/bring/${originId}/${job.id}`;

  if (job.stage === "done") {
    const looked = await bringLook(ctx.app, ctx.auth.user!, job);
    if (!looked.ok) return notFoundPage(ctx);
    const { repo, needs } = looked.value;
    const open = `/${repo.ownerName}/${repo.name}/app`;
    if (looked.value.app === undefined)
      return page({
        ctx,
        title: `Brought ${job.fullName}`,
        body: html`<div class="page-head"><h1>${job.fullName} is here</h1></div>
          <div class="narrow-wide">
            ${card(
              html`<p>
                  The code and its history are copied, linked back to
                  <span class="mono">${job.fullName}</span> so your improvements
                  can flow to its author. Running it starts it as a private
                  app at its own address.
                </p>
                <form method="post" action="${here}/run" class="bar">
                  ${btn("Run it here", { variant: "primary", icon: "rocket" })}
                </form>`,
              { head: html`${icon("rocket")}<h2>Ready to run</h2>` },
            )}
          </div>`,
      });
    const asking = needs.filter((n) => !n.set);
    return page({
      ctx,
      title: `Brought ${job.fullName}`,
      body: html`<div class="page-head"><h1>${job.fullName} is here</h1></div>
        <div class="narrow-wide">
          ${card(
            html`<p>
                It is deploying now as a private app, linked back to
                <span class="mono">${job.fullName}</span> so your improvements
                can flow to its author. Watch the first deploy on its page.
              </p>
              <div class="bar">${btn("Watch the first deploy", { href: open, variant: "primary", icon: "rocket" })}</div>`,
            { head: html`${icon("rocket")}<h2>Live here</h2>` },
          )}
          ${asking.length === 0
            ? null
            : card(
                html`<p class="muted small">
                    The app lists these in its <span class="mono">.env.example</span>.
                    Nothing came with it: give what you want it to have, leave the
                    rest empty. Values are sealed and the app redeploys.
                  </p>
                  <form method="post" action="${here}/env" class="stack">
                    ${asking.map((n) =>
                      field({ label: n.name, name: `v_${n.name}`, type: "password", mono: true, autocomplete: "off", spellcheck: false }),
                    )}
                    <div class="bar">${btn("Save and continue", { variant: "primary", icon: "key" })}</div>
                  </form>`,
                { head: html`${icon("key")}<h2>What it needs</h2>` },
              )}
        </div>`,
    });
  }

  const running = job.stage !== "failed";
  const stream = `/api/v1/user/origins/${originId}/mirror/${job.id}/stream`;
  return page({
    ctx,
    title: `Bringing ${job.fullName}`,
    body: html`<div class="page-head"><h1>Bringing ${job.fullName}</h1></div>
      <div class="narrow-wide">
        ${card(stageList(job, running ? stream : "", here), {
          head: html`${icon("download")}<h2>${job.fullName}</h2>`,
        })}
        ${job.stage === "failed"
          ? html`<p class="mt" role="alert">${job.error ?? "The import failed."}</p>
              <div class="bar mt">${btn("Try another link", { href: "/bring", variant: "outline" })}</div>`
          : html`<p class="muted small mt">
              This keeps going if you close the page; come back to this link.
              <noscript>Without JavaScript, <a href="${here}">reload</a> to see where it is.</noscript>
            </p>`}
      </div>`,
    scriptJs: mirrorJs,
  });
}

/** POST /bring/:id/:job/run: register the brought copy as an app and deploy it. */
export async function bringRun(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const data = await readForm(ctx, "admin");
  if (data instanceof Response) return data;
  const originId = ctx.params.id ?? "";
  const found = mirrorJobFor(ctx.app, ctx.auth.user, originId, ctx.params.job ?? "");
  if (!found.ok) return notFoundPage(ctx);
  const brought = await bringLanded(ctx.app, ctx.auth.user!, found.value);
  if (!brought.ok) return notFoundPage(ctx);
  return redirect(`/bring/${originId}/${found.value.id}`);
}

/** POST /bring/:id/:job/env */
export async function bringEnvSubmit(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const data = await readForm(ctx, "admin");
  if (data instanceof Response) return data;
  const found = mirrorJobFor(ctx.app, ctx.auth.user, ctx.params.id ?? "", ctx.params.job ?? "");
  if (!found.ok) return notFoundPage(ctx);
  const brought = await bringLanded(ctx.app, ctx.auth.user!, found.value);
  if (!brought.ok) return notFoundPage(ctx);
  const values = new Map<string, string>();
  for (const { name } of brought.value.needs) {
    const v = data.get(`v_${name}`);
    if (typeof v === "string") values.set(name, v);
  }
  await setBroughtEnv(ctx.app, ctx.auth.user!, brought.value, values);
  const { repo } = brought.value;
  return redirect(`/${repo.ownerName}/${repo.name}/app`);
}
