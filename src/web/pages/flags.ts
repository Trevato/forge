/**
 * Flags, for a forge admin: every declared flag (`core/flags.ts`) with why it
 * exists, its default, the issue that owns removing it and its live value,
 * which an admin sets or clears. A change is stored and reloaded in the same
 * request, so the next page of anyone's meets it; nothing needs a restart.
 * Anyone else is told 403, and an agent is never an admin here.
 */

import { readFlags } from "../../actions/flags_view.ts";
import { checkInput, FLAGS_ADMIN_ONLY, flagRegistry, usesLine, winnerOffer, mayManageFlags, useFlagRegistry, type FlagValue } from "../../core/flags.ts";
import { makeWinnerDefault } from "../../actions/flag_winner.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, empty, icon, row } from "../ui.ts";
import { accountSections } from "./origins.ts";

export { useFlagRegistry };

function denied(ctx: Ctx): Response | undefined {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  if (mayManageFlags(user)) return undefined;
  return page(
    {
      ctx,
      title: "Forbidden",
      body: html`<div class="page-head"><h1>403</h1></div>
        ${empty({
          icon: "lock",
          title: "Admins only",
          note: FLAGS_ADMIN_ONLY,
          action: btn("Go home", { href: "/", variant: "primary" }),
        })}`,
    },
    403,
  );
}

/** The owner issue on the forge's own repository; plain text when it has none. */
export function issueLink(repo: string | undefined, n: number) {
  return repo === undefined
    ? html`#${String(n)}`
    : html`<a href="/${repo}/issues/${String(n)}">#${String(n)}</a>`;
}

function summary(v: FlagValue | undefined) {
  if (v === undefined) return "not set";
  return [
    v.forge === undefined ? "" : `forge ${v.forge ? "on" : "off"}`,
    v.users ? `${v.users.length} user(s)` : "",
    v.roles ? `roles ${v.roles.join(", ")}` : "",
    v.percent === undefined ? "" : `${v.percent}%`,
  ]
    .filter((x) => x !== "")
    .join(" · ");
}

// GET /settings/flags
export function flagsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const no = denied(ctx);
  if (no) return no;
  const registry = timePhase(ctx.request, "registry", flagRegistry);
  const repo = ctx.app.config.forgeRepo;
  const read = timePhase(ctx.request, "values", () => readFlags(ctx.auth.user));
  const flags = read.ok ? read.flags : [];
  const names = flags.map((f) => f.name);
  // The per-flag reads are interleaved with building each row: sum each.
  let usesMs = 0;
  const rendering = performance.now();
  const rows = flags.map((decl) => {
    const { name, value: v } = decl;
    const t1 = performance.now();
    const week = registry.uses(ctx.app.db, name, 7);
    const month = registry.uses(ctx.app.db, name, 30);
    const t2 = performance.now();
    usesMs += t2 - t1;
    const lead = winnerOffer(month, v);
    return row({
      nav: true,
      lead: icon("activity"),
      title: html`<span class="mono">${name}</span>`,
      meta: html`${decl.why}<br />Default
        <span class="mono">${decl.default ? "on" : "off"}</span> · owner
        ${issueLink(repo, decl.issue)} ·
        live: ${summary(v)}<br /><span class="mono">${usesLine(week, month)}</span>`,
      trail: html`<form class="row-fields" method="post" action="/settings/flags">
        <input type="hidden" name="name" value="${name}" />
        <select class="input" name="forge" aria-label="${name} for the forge">
          <option value="" ${v?.forge === undefined ? "selected" : ""}>forge: default</option>
          <option value="on" ${v?.forge === true ? "selected" : ""}>forge: on</option>
          <option value="off" ${v?.forge === false ? "selected" : ""}>forge: off</option>
        </select>
        <input class="input mono" name="users" placeholder="user ids" value="${(v?.users ?? []).join(", ")}" aria-label="${name} users" />
        <input class="input mono" name="roles" placeholder="roles" value="${(v?.roles ?? []).join(", ")}" aria-label="${name} roles" />
        <input class="input mono" name="percent" placeholder="%" size="3" value="${v?.percent === undefined ? "" : String(v.percent)}" aria-label="${name} percent" />
        ${btn("Save", { size: "sm", variant: "primary", label: `Save ${name}` })}
        ${btn("Clear", { size: "sm", name: "clear", value: "1", label: `Clear ${name}` })}
        ${lead === undefined
          ? ""
          : btn(`Make ${lead} the default`, { size: "sm", name: "winner", value: lead, label: `Make ${lead} the default for ${name}` })}
      </form>`,
    });
  });
  const body = html`<section class="settings-block">
    <h2>Flags</h2>
    ${names.length === 0
      ? html`<p class="muted">No flag is declared yet.</p>`
      : html`<ul class="list setting-list">
          ${rows}
        </ul>`}
  </section>`;
  const response = page({
    ctx,
    title: "Flags",
    body: html`<div class="page-head"><h1>Flags</h1></div>
      ${settingsLayout(accountSections("flags", { admin: true }), body, "Account settings")}`,
  });
  notePhase(ctx.request, "uses", usesMs);
  notePhase(ctx.request, "render", Math.max(performance.now() - rendering - usesMs, 0));
  return response;
}

// POST /settings/flags
export async function flagsSet(ctx: Ctx): Promise<Response> {
  // Checked before the body is read: a non-admin learns nothing of the door.
  const no = denied(ctx);
  if (no) return no;
  const registry = flagRegistry();
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const name = field(form, "name");
  const winner = field(form, "winner");
  if (winner === "on" || winner === "off") {
    const made = makeWinnerDefault(ctx.app, ctx.auth.user!, name, winner);
    return flashTo(
      ctx,
      "/settings/flags",
      made.ok
        ? { message: `${name}: ${winner} is the default; issue #${made.issue.number} asks the crew to remove the flag.` }
        : { tone: "danger", message: made.message },
    );
  }
  const checked =
    field(form, "clear") === "1"
      ? ({ ok: true, value: undefined } as const)
      : checkInput({
          forge: field(form, "forge"),
          users: field(form, "users"),
          roles: field(form, "roles"),
          percent: field(form, "percent"),
        });
  const stored =
    checked.ok && registry.set(ctx.app.db, name, checked.value, ctx.auth.user!.id);
  return flashTo(
    ctx,
    "/settings/flags",
    !checked.ok
      ? { tone: "danger", message: checked.message }
      : !stored
        ? { tone: "danger", message: "There is no such flag." }
        : { message: `${name}: ${checked.value === undefined ? "cleared" : "saved"}.` },
  );
}
