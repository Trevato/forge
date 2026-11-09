/**
 * Features, for a site admin: every app whose forge.json declares a
 * `feature`, absorbed or not, with the switch that absorbs it, and each
 * absorbed feature's settings as a form typed by the app's declaration. The
 * rules live in `actions/features.ts`; this page only asks and shows.
 * Anyone else is told the forge's 404, as every admin page does.
 */

import {
  absorbApp,
  acceptDeclaration,
  changeFeatureSettings,
  feedOf,
  getFeature,
  listFeatures,
  unabsorbApp,
  type FeatureView,
  type SettingView,
  provenanceFacts,
} from "../../actions/features.ts";
import { runNow } from "../../apps/feature_run.ts";
import { runtimeReach, type Reach } from "../../apps/feature_schedule.ts";
import { getAppBySlug, type AppRecord } from "../../core/apps.ts";
import { DAYS } from "../../apps/feature.ts";
import type { FeedItem } from "../../feed/rank.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { readForm, type Form } from "../form.ts";
import { html, raw, when } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, empty, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  return undefined;
}

/** The guide for app authors and admins. */
const DOCS = "/trevato/forge/blob/main/docs/features/absorb.md";

const DAY_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function shell(ctx: Ctx, title: string, body: ReturnType<typeof html>): Response {
  return page({
    ctx,
    title,
    body: html`<div class="page-head"><h1>${title}</h1></div>
      ${settingsLayout(accountSections("features", { admin: true }), body, "Account settings")}`,
  });
}

/** What the switch does, in one sentence. */
export function switchNote(f: Pick<FeatureView, "name" | "absorbed">): string {
  return f.absorbed ? `Un-absorbing takes ${f.name} off every menu; its settings are kept.` : `Absorbing restarts ${f.name} and adds it to the menu.`;
}

/** Where the app comes from, on a feature's own page: `dl` rows, the upstream when a fork and who last changed it. */
export function provenanceRows(p: FeatureView["provenance"]) {
  const facts = provenanceFacts(p);
  if (facts.length === 0) return null;
  return html`<dl class="status-rows">${facts.map((f) => html`<div class="status-row"><dt>${f.label}</dt><dd>${f.value}</dd></div>`)}</dl>`;
}

function featureRow(f: FeatureView) {
  const base = `/settings/features/${encodeURIComponent(f.slug)}`;
  return row({
    title: html`${f.name} <span class="muted small mono">${f.repo}</span>
      ${f.absorbed ? badge("absorbed", { tone: "success" }) : null}
      ${f.pending !== null ? badge("declaration changed: review", { tone: "attn" }) : null}`,
    facts: provenanceFacts(f.provenance),
    meta: html`${f.pending !== null
      ? html`Menu: <strong>${f.name}</strong> at <span class="mono">${f.page}</span> → app: <strong>${f.pending.name}</strong> at
          <span class="mono">${f.pending.page}</span>${f.pending.summary !== null
            ? html`<br />Menu title: ${f.pending.summary}`
            : html`<br />Menu title: none`}`
      : f.problem !== null
      ? html`<span class="danger">${f.problem}</span>`
      : html`${f.summary ?? ""}${when(f.summary !== null, () => html`<br />`)}${f.settings.length} setting${f.settings.length === 1 ? "" : "s"}${f.absorbed
          ? html` · absorbed by ${f.absorbedBy ?? "someone"}`
          : null}`}<br /><span id="sw-${f.slug}">${switchNote(f)}</span>`,
    trail: html`${when(f.pending !== null, () => html`<form class="row-fields" method="post" action="${base}/accept">
        <input type="hidden" name="name" value="${f.pending?.name ?? ""}" />
        <input type="hidden" name="page" value="${f.pending?.page ?? ""}" />
        ${btn("Accept", { size: "sm", label: `Accept ${f.pending?.name ?? ""} as ${f.name}'s menu entry` })}
      </form>`)}<form class="row-fields" method="post" action="${base}/${f.absorbed ? "unabsorb" : "absorb"}" aria-describedby="sw-${f.slug}">
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
  const body = html`<section class="settings-block">
      <h2>Features</h2>
      <p class="muted">An absorbed app is a menu link with its settings kept here.</p>
      ${listed.value.length === 0
        ? empty({
            icon: "rocket",
            title: "No app declares a feature yet",
            note: 'An app declares one with a "feature" block in its forge.json: a name, a page and typed settings.',
            action: html`<p><a href="${DOCS}">How an app declares a feature</a></p>`,
          })
        : html`<ul class="list setting-list">
            ${listed.value.map(featureRow)}
          </ul>`}
    </section>`;
  const response = shell(ctx, "Features", body);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

function input(s: SettingView, invalid = false) {
  const name = `s.${s.key}`;
  const bad = invalid ? raw('aria-invalid="true"') : null;
  switch (s.type) {
    case "bool":
      return html`<input type="hidden" name="${name}" value="off" /><label class="check"
          ><input type="checkbox" name="${name}" value="on" ${s.value === "true" ? "checked" : ""} /> ${s.label}</label
        >`;
    case "int":
      return html`<input class="input mono" type="number" name="${name}" value="${s.value}"
        ${s.min === null ? "" : html`min="${String(s.min)}"`} ${s.max === null ? "" : html`max="${String(s.max)}"`}
        aria-label="${s.label}" ${bad} />`;
    case "choice":
      return html`<select class="input" name="${name}" aria-label="${s.label}" ${bad}>
        ${(s.choices ?? []).map((c) => html`<option value="${c}" ${c === s.value ? "selected" : ""}>${c}</option>`)}
      </select>`;
    case "days": {
      const on = new Set(s.value.split(",").filter(Boolean));
      return html`<input type="hidden" name="${name}" value="" />${DAYS.map(
        (d) => html`<label class="check"><input type="checkbox" name="${name}" value="${d}" ${on.has(d) ? "checked" : ""} /> ${DAY_LABEL[d] ?? d}</label>`,
      )}`;
    }
    case "list":
      return html`<textarea class="input mono" name="${name}" rows="3" aria-label="${s.label}" ${bad}>${s.value.split(",").filter(Boolean).join("\n")}</textarea>`;
    case "secret":
      return html`<input class="input mono" type="password" name="${name}" value="" autocomplete="new-password"
        aria-label="${s.label}" aria-describedby="kept-${s.key}" ${bad} />`;
    default:
      return html`<input class="input" name="${name}" value="${s.value}" aria-label="${s.label}" ${bad} />`;
  }
}

// GET /settings/features/:slug
export async function featurePage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const no = requireAdmin(ctx);
  if (no) return no;
  const found = await timePhase(ctx.request, "feature", () => getFeature(ctx.app, ctx.auth.user, ctx.params["slug"] ?? ""));
  if (!found.ok) return notFoundPage(ctx);
  const rendering = performance.now();
  const response = featureView(ctx, found.value, undefined, feedOf(ctx.app, ctx.auth.user, found.value, 10));
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** What a refused save hands back: the values as typed, and the one that was refused. */
interface Refused {
  readonly typed: Readonly<Record<string, unknown>>;
  readonly key: string | undefined;
  readonly message: string;
}

/** A setting's value as the form sent it, in the shape `input` draws. */
function typedValue(s: SettingView, raw: unknown): string {
  if (Array.isArray(raw)) return raw.map(String).join(",");
  const text = String(raw ?? "");
  if (s.type === "bool") return text === "on" ? "true" : "false";
  if (s.type === "list") return text.split(/[\n,]/).map((t) => t.trim()).filter(Boolean).join(",");
  return text;
}

function featureView(ctx: Ctx, f: FeatureView, refused?: Refused, items: readonly FeedItem[] = []): Response {
  const base = `/settings/features/${encodeURIComponent(f.slug)}`;
  const settings = f.settings.map((shown) => {
    const bad = refused?.key === shown.key;
    const s = refused !== undefined && shown.key in refused.typed ? { ...shown, value: typedValue(shown, refused.typed[shown.key]) } : shown;
    return row({
      title: html`${s.label} <span class="muted small mono">${s.env}</span>`,
      meta: html`${bad ? html`<span class="danger" role="alert">${refused.message}</span><br />` : null}${s.help ?? ""}${when(s.help !== null, () => html`<br />`)}${s.type === "secret"
        ? html`<span id="kept-${s.key}">${s.set ? "Kept" : "Not set"}. Typing replaces it; a blank field keeps it. Clear it through the API or MCP.</span>`
        : html`Default <span class="mono">${s.default === "" ? "empty" : s.default}</span>${s.set ? "" : " · not changed"}`}`,
      trail: input(s, bad),
    });
  });
  const body = html`<section class="settings-block">
      <div class="bar">
        <h2>${f.name}</h2>
        ${f.absorbed ? badge("absorbed", { tone: "success" }) : badge("not absorbed", { variant: "outline" })}
      </div>
      ${provenanceRows(f.provenance)}
      ${f.settings.length === 0
        ? html`<p class="muted small">${f.problem ?? "This feature declares no settings."}</p>`
        : html`<form method="post" action="${base}">
            <ul class="list setting-list">${settings}</ul>
            <p>
              ${f.absorbed
                ? btn("Save", { variant: "primary", label: `Save ${f.name}'s settings` })
                : html`<span class="muted small">Absorb ${f.name} to change its settings.</span>`}
            </p>
          </form>`}
    </section>
    <section class="settings-block">
      <h3>In the feed</h3>
      ${items.length === 0
        ? html`<p class="muted small">Nothing yet.</p>`
        : html`<ul class="list">${items.map((i) => row({
            ...(i.link.startsWith("/") && !i.link.startsWith("//") ? { href: i.link } : {}),
            title: i.what,
            meta: html`${i.actor ?? i.app} · ${time(i.at)}`,
          }))}</ul>`}
    </section>
    ${when(f.fires.length > 0, () => html`<section class="settings-block">
      <h3>Scheduled</h3>
      <ul class="list">${f.fires.map((x) => row({
        title: html`<span class="mono">${x.tool}</span>`,
        meta: html`${x.ok ? "ok" : html`<span class="danger">${x.error ?? "failed"}</span>`} · ${time(new Date(x.at).toISOString())} · ${x.durationMs} ms`,
        trail: html`<form method="post" action="${base}/run/${encodeURIComponent(x.tool)}">${btn("Run now", { label: `Run ${x.tool} now` })}</form>`,
      }))}</ul>
    </section>`)}
    <p class="muted small">
      Saving restarts ${f.name}: its process reads each setting as an environment variable, named on the right.
      <a href="/settings/features">All features</a>
    </p>`;
  const answered = shell(ctx, f.name, html`${refused !== undefined && refused.key === undefined ? html`<p class="danger" role="alert">${refused.message}</p>` : null}${body}`);
  return refused === undefined ? answered : new Response(answered.body, { status: 422, headers: answered.headers });
}

/** The form's settings, as the action takes them: `days` from its checkboxes, the rest as sent. */
export function settingsFromForm(form: Form, settings: readonly SettingView[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of settings) {
    const name = `s.${s.key}`;
    const all = form.getAll(name).map(String);
    if (all.length === 0) continue;
    if (s.type === "secret" && (all[all.length - 1] ?? "") === "") continue; // blank keeps what is kept
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
  const typed = settingsFromForm(form, found.value.settings);
  const changed = await changeFeatureSettings(ctx.app, ctx.auth.user, slug, typed);
  const back = `/settings/features/${encodeURIComponent(slug)}`;
  if (!changed.ok && changed.error.error === "not_found") return notFoundPage(ctx);
  if (changed.ok) return flashTo(ctx, back, { message: `${changed.value.name}: saved. It restarts with the new settings.` });
  if (changed.error.error === "invalid_setting")
    return featureView(ctx, found.value, { typed, key: changed.error.key, message: changed.error.message });
  return flashTo(ctx, back, { tone: "danger", message: changed.error.message });
}

/** POST /settings/features/:slug/run/:tool, with `reachOf` the seam a test replaces. */
export function featureRun(reachOf: (app: Ctx["app"], record: AppRecord) => Reach = runtimeReach) {
  return async (ctx: Ctx): Promise<Response> => {
    const no = requireAdmin(ctx);
    if (no) return no;
    const form = await readForm(ctx, "admin");
    if (form instanceof Response) return form;
    const slug = ctx.params["slug"] ?? "";
    const tool = ctx.params["tool"] ?? "";
    const record = getAppBySlug(ctx.app.db, slug);
    if (record === undefined) return notFoundPage(ctx);
    const back = `/settings/features/${encodeURIComponent(slug)}`;
    const said = await runNow(ctx.app.db, record.id, tool, reachOf(ctx.app, record));
    return flashTo(ctx, back, said.ok ? { message: said.message } : { tone: "danger", message: said.message });
  };
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

// POST /settings/features/:slug/accept
export async function featureAccept(ctx: Ctx): Promise<Response> {
  const no = requireAdmin(ctx);
  if (no) return no;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const reviewed = { name: String(form.get("name") ?? ""), page: String(form.get("page") ?? "") };
  const done = await acceptDeclaration(ctx.app, ctx.auth.user, ctx.params["slug"] ?? "", reviewed);
  if (!done.ok && done.error === "not_found") return notFoundPage(ctx);
  return flashTo(
    ctx,
    "/settings/features",
    done.ok
      ? { message: `${done.value.name} is now the menu's entry for this app.` }
      : {
          tone: "danger",
          message:
            done.error === "declaration_changed"
              ? "The app declared something else since you looked. Review the new declaration and accept again."
              : "That app is not absorbed, or no longer declares a feature.",
        },
  );
}
