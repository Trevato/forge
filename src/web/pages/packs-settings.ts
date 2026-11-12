/**
 * Settings › Packs (#10532), for a site admin: the repos /packs shows. A pack
 * is a public forge repo with a `pack.json` at its root; only the repos listed
 * here are read, so a repo not marked is not a pack. The rule lives in
 * `packs/marked.ts`; this page asks, shows and, once saved, re-reads git so
 * the change is on /packs at once.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { refreshCatalogQuietly } from "../../packs/catalog.ts";
import { setPackRepos } from "../../packs/set.ts";
import { markedRepos, rejectedMarkedSentence } from "../../packs/marked.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, pageHead, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, field as uiField, row } from "../ui.ts";
import { accountSections } from "./origins.ts";

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  return undefined;
}

/** A problem as the catalog words it, "owner/name: reason", split into its two halves. */
const problemRow = (p: string) => {
  const at = p.indexOf(": ");
  return row({
    title: html`<span class="mono">${at < 0 ? p : p.slice(0, at)}</span>`,
    meta: html`${at < 0 ? "" : p.slice(at + 2)}`,
  });
};

function view(ctx: Ctx, problems: readonly string[], text: string, error?: string, status = 200): Response {
  const body: Html = html`<section class="settings-block">
    <form method="post" action="/settings/packs">
      ${uiField({ label: "Repositories", name: "repos", type: "textarea", rows: 3, value: text, mono: true, spellcheck: false, hint: "owner/name, like packs/games; separated by a space, comma or new line.", ...(error ? { error } : {}) })}
      <div class="form-actions">${btn("Save", { variant: "primary" })}</div>
    </form>
  </section>
  ${when(problems.length > 0, () => html`<section class="settings-block">
    <h2>Left out</h2>
    <ul class="list">${problems.map(problemRow)}</ul>
  </section>`)}`;
  return page(
    {
      ctx,
      title: "Packs",
      body: html`${pageHead("Packs", { sub: "/packs lists the public repositories named here, each with a pack.json at its root, and no others." })}${settingsLayout(accountSections("packs", { admin: true }), body, "Account settings")}`,
    },
    status,
  );
}

// GET /settings/packs
export async function packsSettingsPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const { problems } = await refreshCatalogQuietly(ctx.app);
  const rendering = performance.now();
  const response = view(ctx, problems, markedRepos(ctx.app.db).join("\n"));
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/packs
export async function packsSettingsSave(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const text = field(form, "repos");
  const saved = await setPackRepos(ctx.app, ctx.auth.user, text);
  if (!saved.ok) {
    if (saved.error === "forbidden") return notFoundPage(ctx);
    return view(ctx, [], text.slice(0, 4000), rejectedMarkedSentence(saved.rejected), 422);
  }
  return flashTo(ctx, "/settings/packs", {
    message: saved.problems.length === 0 ? "Pack repositories saved." : `Pack repositories saved; ${saved.problems.length} could not be read.`,
  });
}
