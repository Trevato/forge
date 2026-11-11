/**
 * App templates, for a forge admin: the repositories New app offers, with a
 * form to mark another or unmark one. Anyone else is told 403.
 */

import { MARK_TEMPLATE_ERRORS, markTemplate } from "../../actions/app_templates.ts";
import { DEFAULT_TEMPLATE, markedTemplates } from "../../core/app_templates.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, empty, field as formField, icon, row } from "../ui.ts";
import { accountSections } from "./origins.ts";

function denied(ctx: Ctx): Response | undefined {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  if (user.isAdmin && user.kind === "user") return undefined;
  return page(
    {
      ctx,
      title: "Forbidden",
      body: html`<div class="page-head"><h1>403</h1></div>
        ${empty({
          icon: "lock",
          title: "Admins only",
          note: MARK_TEMPLATE_ERRORS.forbidden,
          action: btn("Go home", { href: "/", variant: "primary" }),
        })}`,
    },
    403,
  );
}

// GET /settings/app-templates
export function appTemplatesPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const no = denied(ctx);
  if (no) return no;
  const rendering = performance.now();
  const rows = markedTemplates(ctx.app.db).map((repo) => {
    const name = `${repo.ownerName}/${repo.name}`;
    return row({
      lead: icon("rocket"),
      title: html`<a class="mono" href="/${name}">${name}</a>`,
      meta: html`${name === DEFAULT_TEMPLATE ? "Always offered, first." : repo.visibility === "private" ? "Private: offered only to people who can read it." : ""}`,
      trail:
        name === DEFAULT_TEMPLATE
          ? html``
          : html`<form method="post" action="/settings/app-templates">
              <input type="hidden" name="repo" value="${name}" />
              <input type="hidden" name="marked" value="0" />
              ${btn("Unmark", { size: "sm", label: `Unmark ${name}` })}
            </form>`,
    });
  });
  const body = html`<section class="settings-block">
    <p class="muted">The repositories New app can copy.</p>
    ${rows.length === 0 ? html`<p class="muted">No template is marked.</p>` : html`<ul class="list setting-list">${rows}</ul>`}
    <form method="post" action="/settings/app-templates">
      <input type="hidden" name="marked" value="1" />
      ${formField({ label: "Mark a repository", name: "repo", placeholder: "owner/name", mono: true, required: true })}
      ${btn("Mark as template", { variant: "primary" })}
    </form>
  </section>`;
  const response = page({
    ctx,
    title: "App templates",
    body: html`<div class="page-head"><h1>App templates</h1></div>
      ${settingsLayout(accountSections("templates", { admin: true }), body, "Account settings")}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/app-templates
export async function appTemplatesSet(ctx: Ctx): Promise<Response> {
  const no = denied(ctx);
  if (no) return no;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const marked = field(form, "marked") === "1";
  const done = markTemplate(ctx.app, ctx.auth.user, field(form, "repo"), marked);
  return flashTo(
    ctx,
    "/settings/app-templates",
    done.ok
      ? { message: `${done.value.name} is ${marked ? "marked" : "unmarked"}.` }
      : { tone: "danger", message: MARK_TEMPLATE_ERRORS[done.error] },
  );
}
