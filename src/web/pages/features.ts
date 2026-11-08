/**
 * Features, for a site admin: every app whose forge.json declares a
 * `feature`, absorbed or not, with the switch that absorbs it, and each
 * absorbed feature's settings as a form typed by the app's declaration. The
 * rules live in `actions/features.ts`; this page only asks and shows.
 * Anyone else is told the forge's 404, as every admin page does.
 */

import {
  absorbApp,
  changeFeatureSettings,
  getFeature,
  listFeatures,
  unabsorbApp,
  type FeatureView,
  type SettingView,
} from "../../actions/features.ts";
import { DAYS } from "../../apps/feature.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { readForm, type Form } from "../form.ts";
import { html, when } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, card, empty, icon, row } from "../ui.ts";
import { accountSections } from "./origins.ts";

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  return undefined;
}

const DAY_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function shell(ctx: Ctx, title: string, body: ReturnType<typeof html>): Response {
  return page({
    ctx,
    title,
    body: html`<div class="page-head"><h1>${title}</h1></div>
      ${settingsLayout(accountSections("features", { admin: true }), body, "Account settings")}`,
  });
}

function featureRow(f: FeatureView) {
  const base = `/settings/features/${encodeURIComponent(f.slug)}`;
  return row({
    lead: icon("rocket"),
    title: html`${f.name} <span class="muted small mono">${f.repo}</span>
      ${f.absorbed ? badge("absorbed", { tone: "success" }) : null}`,
    meta: f.problem !== null
      ? html`<span class="danger">${f.problem}</span>`
      : html`${f.summary ?? ""}${when(f.summary !== null, () => html`<br />`)}${f.settings.length} setting${f.settings.length === 1 ? "" : "s"}${f.absorbed
          ? html` · absorbed by ${f.absorbedBy ?? "someone"}`
          : html` · not absorbed: the app runs as an ordinary app`}`,
    trail: html`<form class="row-fields" method="post" action="${base}/${f.absorbed ? "unabsorb" : "absorb"}">
      ${when(f.absorbed, () => btn("Settings", { size: "sm", href: base }))}
      ${btn(f.absorbed ? "Un-absorb" : "Absorb", {
        size: "sm",
        variant: f.absorbed ? "secondary" : "primary",
        label: `${f.absorbed ? "Un-absorb" : "Absorb"} ${f.name}`,
      })}
    </form>`,
  });
}

// GET /settings/features
export async function featuresPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const no = requireAdmin(ctx);
  if (no) return no;
  const listed = await timePhase(ctx.request, "features", () => listFeatures(ctx.app, ctx.auth.user));
  if (!listed.ok) return notFoundPage(ctx);
  const rendering = performance.now();
  const body = card(
    listed.value.length === 0
      ? html`<div class="card-body">
          ${empty({
            icon: "rocket",
            title: "No app declares a feature yet",
            note: 'An app declares one with a "feature" block in its forge.json: a name, a page and typed settings. Absorbing it puts it in the forge\'s nav and keeps its settings here.',
          })}
        </div>`
      : html`<ul class="list setting-list">
          ${listed.value.map(featureRow)}
        </ul>`,
    {
      head: html`${icon("rocket")}
        <h2>Features</h2>`,
      pad: false,
    },
  );
  const response = shell(ctx, "Features", body);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

function input(s: SettingView) {
  const name = `s.${s.key}`;
  switch (s.type) {
    case "bool":
      return html`<input type="hidden" name="${name}" value="off" /><label class="check"
          ><input type="checkbox" name="${name}" value="on" ${s.value === "true" ? "checked" : ""} /> ${s.label}</label
        >`;
    case "int":
      return html`<input class="input mono" type="number" name="${name}" value="${s.value}"
        ${s.min === null ? "" : html`min="${String(s.min)}"`} ${s.max === null ? "" : html`max="${String(s.max)}"`}
        aria-label="${s.label}" />`;
    case "choice":
      return html`<select class="input" name="${name}" aria-label="${s.label}">
        ${(s.choices ?? []).map((c) => html`<option value="${c}" ${c === s.value ? "selected" : ""}>${c}</option>`)}
      </select>`;
    case "days": {
      const on = new Set(s.value.split(",").filter(Boolean));
      return html`<input type="hidden" name="${name}" value="" />${DAYS.map(
        (d) => html`<label class="check"><input type="checkbox" name="${name}" value="${d}" ${on.has(d) ? "checked" : ""} /> ${DAY_LABEL[d] ?? d}</label>`,
      )}`;
    }
    case "list":
      return html`<textarea class="input mono" name="${name}" rows="3" aria-label="${s.label}">${s.value.split(",").filter(Boolean).join("\n")}</textarea>`;
    default:
      return html`<input class="input" name="${name}" value="${s.value}" aria-label="${s.label}" />`;
  }
}

// GET /settings/features/:slug
export async function featurePage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const no = requireAdmin(ctx);
  if (no) return no;
  const found = await timePhase(ctx.request, "feature", () => getFeature(ctx.app, ctx.auth.user, ctx.params["slug"] ?? ""));
  if (!found.ok) return notFoundPage(ctx);
  const f = found.value;
  const rendering = performance.now();
  const base = `/settings/features/${encodeURIComponent(f.slug)}`;
  const settings = f.settings.map((s) =>
    row({
      lead: icon("settings"),
      title: html`${s.label} <span class="muted small mono">${s.env}</span>`,
      meta: html`${s.help ?? ""}${when(s.help !== null, () => html`<br />`)}Default
        <span class="mono">${s.default === "" ? "empty" : s.default}</span>${s.set ? "" : " · not changed"}`,
      trail: input(s),
    }),
  );
  const body = html`${card(
      f.settings.length === 0
        ? html`<div class="card-body"><p class="muted small">${f.problem ?? "This feature declares no settings."}</p></div>`
        : html`<form method="post" action="${base}">
            <ul class="list setting-list">${settings}</ul>
            <div class="card-body">
              ${f.absorbed
                ? btn("Save", { variant: "primary", label: `Save ${f.name}'s settings` })
                : html`<p class="muted small">Absorb ${f.name} to change its settings.</p>`}
            </div>
          </form>`,
      {
        head: html`${icon("rocket")}
          <h2>${f.name}</h2>
          ${f.absorbed ? badge("absorbed", { tone: "success" }) : badge("not absorbed", { variant: "outline" })}`,
        pad: false,
      },
    )}
    <p class="muted small">
      Saving restarts ${f.name}: its process reads each setting as an environment variable, named on the right.
      <a href="/settings/features">All features</a>
    </p>`;
  const response = shell(ctx, f.name, body);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** The form's settings, as the action takes them: `days` from its checkboxes, the rest as sent. */
export function settingsFromForm(form: Form, settings: readonly SettingView[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of settings) {
    const name = `s.${s.key}`;
    const all = form.getAll(name).map(String);
    if (all.length === 0) continue;
    if (s.type === "days") out[s.key] = all.filter((d) => d !== "");
    else if (s.type === "bool") out[s.key] = all.includes("on") ? "on" : "off";
    else out[s.key] = all[all.length - 1] ?? "";
  }
  return out;
}

// POST /settings/features/:slug
export async function featureSave(ctx: Ctx): Promise<Response> {
  const no = requireAdmin(ctx);
  if (no) return no;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const slug = ctx.params["slug"] ?? "";
  const found = await getFeature(ctx.app, ctx.auth.user, slug);
  if (!found.ok) return notFoundPage(ctx);
  const changed = await changeFeatureSettings(ctx.app, ctx.auth.user, slug, settingsFromForm(form, found.value.settings));
  const back = `/settings/features/${encodeURIComponent(slug)}`;
  if (!changed.ok && changed.error.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    back,
    changed.ok
      ? { message: `${changed.value.name}: saved. It restarts with the new settings.` }
      : { tone: "danger", message: changed.error.message },
  );
}

// POST /settings/features/:slug/absorb and /unabsorb
export function featureSwitch(absorbing: boolean) {
  return async (ctx: Ctx): Promise<Response> => {
    const no = requireAdmin(ctx);
    if (no) return no;
    const form = await readForm(ctx, "admin");
    if (form instanceof Response) return form;
    const slug = ctx.params["slug"] ?? "";
    const done = absorbing ? await absorbApp(ctx.app, ctx.auth.user, slug) : await unabsorbApp(ctx.app, ctx.auth.user, slug);
    if (!done.ok && done.error === "not_found") return notFoundPage(ctx);
    return flashTo(
      ctx,
      "/settings/features",
      done.ok
        ? {
            message: absorbing
              ? `${done.value.name} is absorbed: it is in the forge's nav, and its settings are here.`
              : `${done.value.name} runs as an ordinary app again. Its settings are kept for the next absorb.`,
          }
        : {
            tone: "danger",
            message:
              done.error === "not_a_feature"
                ? "That app's forge.json declares no feature (or declares it wrongly)."
                : done.error === "not_absorbed"
                  ? "That app is not absorbed."
                  : "Only a site admin absorbs apps.",
          },
    );
  };
}
