/**
 * Cloud accounts, for a forge admin: every provider credential the forge
 * holds, sealed and write-only. The page lists provider, name, what the
 * last read-only check said, when it ran, and which run last opened the
 * value — never the value. Below, every recent read, so a use is a visible
 * event. "Write allowed" is off until someone turns it on here.
 */

import {
  addAccount,
  allowWrite,
  auditAccount,
  removeAccount,
  reverify,
} from "../../actions/cloud.ts";
import { LABEL, PROVIDERS, shape } from "../../cloud/providers.ts";
import {
  listCloudAccounts,
  recentCloudReads,
  type CloudRead,
} from "../../core/cloud_account.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, card, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

const BACK = "/settings/cloud";

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

/** A run id in a read event, as words: audits and checks name themselves. */
const runWords = (run: string | null): string =>
  run === null ? "no run" : run.startsWith("audit:") ? `audit (${run.split(":")[1]})` : run.startsWith("verify:") ? "verify" : `run ${run}`;

const hidden = (provider: string, name: string): Html =>
  html`<input type="hidden" name="provider" value="${provider}" />
    <input type="hidden" name="name" value="${name}" />`;

function accountsCard(reads: CloudRead[], ctx: Ctx): Html {
  const accounts = listCloudAccounts(ctx.app.db);
  const rows = accounts.map((a) => {
    const last = reads.find((r) => r.provider === a.provider && r.name === a.name);
    return row({
      lead: icon("key"),
      title: html`${LABEL[a.provider]} / <span class="mono">${a.name}</span>`,
      meta: html`${a.summary}<br />verified ${a.verifiedAt ? time(a.verifiedAt) : "never"} ·
        ${last ? html`last used ${time(last.at)} by ${runWords(last.run)}` : "never used"} ·
        ${a.writeAllowed ? "writes allowed" : "read-only"}`,
      trail: html`<div class="row-actions">
        <form method="post" action="/settings/cloud/verify">
          ${hidden(a.provider, a.name)}${btn("Verify", { size: "sm", label: `Verify ${a.name}` })}
        </form>
        <form method="post" action="/settings/cloud/write">
          ${hidden(a.provider, a.name)}
          <input type="hidden" name="allowed" value="${a.writeAllowed ? "0" : "1"}" />
          ${btn(a.writeAllowed ? "Turn writes off" : "Allow writes", { size: "sm", label: `Write switch for ${a.name}` })}
        </form>
        <form method="post" action="/settings/cloud/audit" class="row-actions">
          ${hidden(a.provider, a.name)}
          <input class="input" type="text" name="repo" placeholder="owner/repo for findings"
            aria-label="Repository for audit findings" maxlength="200" required />
          ${btn("Audit", { size: "sm", label: `Audit ${a.name}` })}
        </form>
        <form method="post" action="/settings/cloud/remove">
          ${hidden(a.provider, a.name)}${btn("Remove", { size: "sm", icon: "x", label: `Remove ${a.name}` })}
        </form>
      </div>`,
    });
  });
  return card(
    html`<div class="card-body">
        <p class="muted small">
          Paste a credential once: the forge checks it with read-only calls,
          says what it can see, then seals it. It is never shown again. Give it
          the narrowest scope the provider offers — an audit only reads. A run
          that declares <span class="mono">writes: yes</span> is refused a
          credential until its write switch is on; the switch cannot make a
          provider key less powerful than it already is.
        </p>
      </div>
      ${when(rows.length > 0, () => html`<ul class="list">${rows}</ul>`)}
      <form class="edit-row" method="post" action="/settings/cloud">
        <select class="input" name="provider" aria-label="Provider" required>
          ${PROVIDERS.map((p) => html`<option value="${p}">${LABEL[p]}</option>`)}
        </select>
        <input class="input mono" type="text" name="name" placeholder="name, e.g. main"
          aria-label="Name" pattern="[a-z][a-z0-9_]{0,31}" maxlength="32"
          autocomplete="off" spellcheck="false" required />
        <input class="input" type="password" name="value" placeholder="Credential"
          aria-label="Credential" autocomplete="off" required />
        ${btn("Verify and seal", { variant: "primary", size: "sm", icon: "plus" })}
      </form>
      <div class="card-body">
        <p class="muted small">
          ${PROVIDERS.map((p) => html`${LABEL[p]}: ${shape[p]}. `)}
        </p>
      </div>`,
    { head: html`${icon("key")}<h2>Cloud accounts</h2>`, pad: false },
  );
}

function readsCard(reads: CloudRead[]): Html {
  return card(
    reads.length === 0
      ? html`<p class="muted small card-body">No credential has been read yet.</p>`
      : html`<ul class="list">
          ${reads.map((r) =>
            row({
              lead: icon("eye"),
              title: html`${LABEL[r.provider]} / <span class="mono">${r.name}</span>`,
              meta: html`${runWords(r.run)} · ${time(r.at)}`,
            }),
          )}
        </ul>`,
    { head: html`${icon("eye")}<h2>Every read</h2>`, pad: false },
  );
}

// GET /settings/cloud
export function cloudPage(ctx: Ctx): Response {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const reads = recentCloudReads(ctx.app.db);
  return page({
    ctx,
    title: "Cloud accounts",
    body: html`<div class="page-head"><h1>Cloud accounts</h1></div>
      ${settingsLayout(
        accountSections("cloud", { admin: true }),
        html`${accountsCard(reads, ctx)}<div class="mt">${readsCard(reads)}</div>`,
        "Account settings",
      )}`,
  });
}

const said = (ctx: Ctx, r: { ok: boolean }, good: string, bad: string | undefined) =>
  flashTo(ctx, BACK, r.ok ? { message: good } : { tone: "danger", message: bad ?? "Not found." });

// POST /settings/cloud
export async function cloudAdd(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = await addAccount(ctx.app, ctx.auth.user, field(form, "provider"), field(form, "name").trim(), field(form, "value").trim());
  return said(ctx, r, r.ok ? `Sealed. ${r.value}` : "", r.ok ? undefined : r.error);
}

// POST /settings/cloud/verify
export async function cloudVerify(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = await reverify(ctx.app, ctx.auth.user, field(form, "provider"), field(form, "name"));
  return said(ctx, r, r.ok ? r.value : "", r.ok ? undefined : r.error);
}

// POST /settings/cloud/write
export async function cloudWrite(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const on = field(form, "allowed") === "1";
  const r = allowWrite(ctx.app, ctx.auth.user, field(form, "provider"), field(form, "name"), on);
  return said(ctx, r, on ? "Runs that need writes may now hold it." : "Writes are off.", r.ok ? undefined : r.error);
}

// POST /settings/cloud/audit
export async function cloudAudit(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = await auditAccount(ctx.app, ctx.auth.user, field(form, "provider"), field(form, "name"), field(form, "repo"));
  return said(
    ctx,
    r,
    r.ok ? `Audit read ${r.value.found} finding(s); opened ${r.value.opened} issue(s). Nothing was changed.` : "",
    r.ok ? undefined : r.error,
  );
}

// POST /settings/cloud/remove
export async function cloudRemove(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = removeAccount(ctx.app, ctx.auth.user, field(form, "provider"), field(form, "name"));
  return said(ctx, r, "Removed.", r.ok ? undefined : r.error);
}
