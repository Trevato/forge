/**
 * Settings → Trusted sources (#8937), for the owner: who may fold in without
 * a person's review, until when; a one-click remove; the kill switch that
 * stops all folding in; and the revert of one source's landings.
 */
import { addTrust, removeTrust, revertBySource, setFoldInStopped } from "../../actions/trusted_sources.ts";
import {
  endsSoon,
  foldInStopped,
  listTrusted,
  type TrustError,
} from "../../core/trusted_sources.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, card, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

function owner(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  return ctx.auth.user.isAdmin && ctx.auth.user.kind !== "agent" ? undefined : notFoundPage(ctx);
}

const WORDS: Record<TrustError | "not_found", string> = {
  bad_host: "That is not a forge address.",
  bad_account: "That is not an account name.",
  bad_date: "Give the end as a date, year-month-day.",
  in_the_past: "That date has passed.",
  not_found: "Not found.",
};

// GET /settings/trusted
export function trustedPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = owner(ctx);
  if (denied) return denied;
  const rendering = performance.now();
  const now = new Date();
  const stopped = foldInStopped(ctx.app.db);
  const entries = listTrusted(ctx.app.db);
  const body = html`${card(
      html`<div class="card-body"><p class="muted small">
        Work from a trusted source flows in as it appears and lands by true merge when its checks pass,
        with no person's review. It never skips the check, the boot proof or the walls: a pull touching
        secrets, credentials, permissions, the contract or release machinery still waits for you. Anyone
        else is a guest, and their pull waits on <a href="/review">review</a>. An account name means
        nothing without its forge.
      </p>
      <form method="post" action="/settings/trusted/stop" class="row-fields">
        <input type="hidden" name="stop" value="${stopped ? "0" : "1"}" />
        ${stopped
          ? html`${badge("Folding in is stopped", { variant: "outline" })}
              <span class="muted small">by ${stopped.by}, <time datetime="${stopped.at}">${stopped.at.slice(0, 10)}</time></span>
              ${btn("Resume folding in", { size: "sm" })}`
          : btn("Stop all folding in", { size: "sm", variant: "outline" })}
      </form></div>`,
      { head: html`${icon("lock")}<h2>Fold-in</h2>` },
    )}
    ${card(
      html`<ul class="list setting-list">
        ${entries.length === 0
          ? html`<li class="muted small">No one is trusted. Everyone waits for review.</li>`
          : entries.map((s) => {
              const lapsed = s.until <= now.toISOString();
              return row({
                lead: icon("user"),
                title: html`${s.account} <span class="muted small mono">${s.host}</span>`,
                meta: html`${lapsed ? "Lapsed, waits for review" : "Until"} ${time(s.until)}${
                  !lapsed && endsSoon(s, now) ? " (ends soon)" : ""
                } · set by ${s.setBy}`,
                trail: html`<form class="row-fields" method="post" action="/settings/trusted/${s.id}/remove">
                    ${btn("Remove", { size: "sm", variant: "outline", label: `Remove ${s.account} on ${s.host}` })}
                  </form>
                  <form class="row-fields" method="post" action="/settings/trusted/revert">
                    <input type="hidden" name="host" value="${s.host}" />
                    <input type="hidden" name="account" value="${s.account}" />
                    <label class="muted small"><input type="checkbox" name="confirm" value="1" required /> Open reverts</label>
                    ${btn("Revert landings", { size: "sm", variant: "outline", label: `Revert what ${s.account} on ${s.host} landed` })}
                  </form>`,
              });
            })}
      </ul>`,
      { head: html`${icon("users")}<h2>Trusted sources</h2>`, pad: false },
    )}
    ${card(
      html`<form method="post" action="/settings/trusted" class="stack">
        <label>Account <input class="input" name="account" required maxlength="64" autocomplete="off" /></label>
        <label>Forge <input class="input" name="host" required maxlength="260" placeholder="git.open-platform.sh" autocomplete="off" /></label>
        <label>Until <input class="input" name="until" type="date" required /></label>
        ${btn("Trust", { icon: "check" })}
      </form>`,
      { head: html`${icon("plus")}<h2>Trust a source</h2>` },
    )}`;
  notePhase(ctx.request, "render", performance.now() - rendering);
  return page({
    ctx,
    title: "Trusted sources",
    body: html`<div class="page-head"><h1>Trusted sources</h1></div>
      ${settingsLayout(accountSections("trusted", { admin: true }), body, "Account settings")}`,
  });
}

// POST /settings/trusted
export async function trustedAdd(ctx: Ctx): Promise<Response> {
  const denied = owner(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const made = addTrust(ctx.app, ctx.auth.user, {
    host: field(form, "host"),
    account: field(form, "account"),
    until: field(form, "until"),
  });
  return flashTo(
    ctx,
    "/settings/trusted",
    made.ok
      ? { message: `${made.value.account} on ${made.value.host} is trusted until ${made.value.until.slice(0, 10)}.` }
      : { tone: "danger", message: WORDS[made.error] },
  );
}

// POST /settings/trusted/:id/remove
export async function trustedRemove(ctx: Ctx): Promise<Response> {
  const denied = owner(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const gone = removeTrust(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  return flashTo(
    ctx,
    "/settings/trusted",
    gone.ok
      ? { message: `${gone.value.account} on ${gone.value.host} now waits for review.` }
      : { tone: "danger", message: WORDS.not_found },
  );
}

// POST /settings/trusted/stop
export async function trustedStop(ctx: Ctx): Promise<Response> {
  const denied = owner(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const stop = field(form, "stop") === "1";
  setFoldInStopped(ctx.app, ctx.auth.user, stop);
  return flashTo(ctx, "/settings/trusted", { message: stop ? "Folding in is stopped." : "Folding in resumed." });
}

// POST /settings/trusted/revert
export async function trustedRevert(ctx: Ctx): Promise<Response> {
  const denied = owner(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  if (field(form, "confirm") !== "1")
    return flashTo(ctx, "/settings/trusted", { tone: "danger", message: "Tick “Open reverts” to confirm." });
  const done = await revertBySource(ctx.app, ctx.auth.user, field(form, "host"), field(form, "account"));
  return flashTo(
    ctx,
    "/settings/trusted",
    done.ok
      ? { message: `${done.value.opened} revert pull${done.value.opened === 1 ? "" : "s"} opened for you to land.` }
      : { tone: "danger", message: WORDS.not_found },
  );
}
