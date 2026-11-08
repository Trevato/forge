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
  renameAccount,
  reverify,
  rotateAccount,
} from "../../actions/cloud.ts";
import { LABEL, PROVIDERS, VENDOR_OF, isProvider, shape } from "../../cloud/providers.ts";
import { HOME, usedFor, usesByVendor, type VendorUse } from "../../cloud/declared.ts";
import { auditToday } from "../../core/cloud_audit.ts";
import {
  listCloudAccounts,
  recentCloudReads,
  type CloudAccount,
  type CloudRead,
} from "../../core/cloud_account.ts";
import { nameFrame, notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, confirmAction, icon, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

const BACK = "/settings/cloud";

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

/** A run id in a read event, as words: audits and checks name themselves. */
const runWords = (run: string | null): string =>
  run === null ? "no run" : run.startsWith("audit:") ? `audit (${run.split(":")[1]})` : run.startsWith("verify:") ? "verify" : run.startsWith("rename:") ? "rename" : `run ${run}`;

const hidden = (provider: string, name: string): Html =>
  html`<input type="hidden" name="provider" value="${provider}" />
    <input type="hidden" name="name" value="${name}" />`;

function accountsCard(accounts: CloudAccount[], reads: CloudRead[], uses: Map<string, VendorUse[]>): Html {
  const rows = accounts.map((a) => {
    const last = reads.find((r) => r.provider === a.provider && r.name === a.name);
    return row({
      lead: icon("key"),
      title: html`${LABEL[a.provider]} / <span class="mono">${a.name}</span>`,
      meta: html`${a.summary}<br />${usedFor(uses.get(VENDOR_OF[a.provider]))}<br />${HOME[a.provider]}<br />verified ${a.verifiedAt ? time(a.verifiedAt) : "never"} ·
        ${last ? html`last used ${time(last.at)} by ${runWords(last.run)}` : "never used"} ·
        ${a.writeAllowed ? "writes allowed" : "read-only"}`,
      trail: html`<div class="row-fields">
        <form method="post" action="/settings/cloud/verify">
          ${hidden(a.provider, a.name)}${btn("Verify", { size: "sm", label: `Verify ${a.name}` })}
        </form>
        <form method="post" action="/settings/cloud/write">
          ${hidden(a.provider, a.name)}
          <input type="hidden" name="allowed" value="${a.writeAllowed ? "0" : "1"}" />
          ${btn(a.writeAllowed ? "Turn writes off" : "Allow writes", { size: "sm", label: `Write switch for ${a.name}` })}
        </form>
        <form method="post" action="/settings/cloud/audit" class="row-fields">
          ${hidden(a.provider, a.name)}
          <input class="input" type="text" name="repo" placeholder="owner/repo for findings"
            aria-label="Repository for audit findings" maxlength="200" required />
          ${btn("Audit", { size: "sm", label: `Audit ${a.name}` })}
        </form>
        <form method="post" action="/settings/cloud/rotate" class="row-fields">
          ${hidden(a.provider, a.name)}
          <input class="input" type="password" name="value" placeholder="New credential"
            aria-label="New credential for ${a.name}" autocomplete="off" required />
          ${btn("Rotate", { size: "sm", label: `Rotate ${a.name}` })}
        </form>
        <form method="post" action="/settings/cloud/rename" class="row-fields">
          ${hidden(a.provider, a.name)}
          <input class="input mono" type="text" name="to" placeholder="new name"
            aria-label="New name for ${a.name}" pattern="[a-z][a-z0-9_]{0,31}" maxlength="32"
            autocomplete="off" spellcheck="false" required />
          ${btn("Rename", { size: "sm", label: `Rename ${a.name}` })}
        </form>
        ${confirmAction({
          action: `/settings/cloud/remove?provider=${encodeURIComponent(a.provider)}&name=${encodeURIComponent(a.name)}`,
          verb: "Remove",
          size: "sm",
        })}
      </div>`,
    });
  });
  return html`<section class="settings-block">
      <h2>Cloud accounts</h2>
      <p class="muted small">Paste a credential once; the forge checks it read-only, seals it, and never shows it again.</p>
      ${rows.length > 0
        ? html`<ul class="list setting-list">${rows}</ul>`
        : html`<p class="muted small">No cloud account is sealed yet. Add one below: pick a provider, name it, paste its credential.</p>`}
    </section>
    <section class="settings-block">
      <h2>Add an account</h2>
      <form class="edit-row" method="post" action="/settings/cloud">
        <select class="input" name="provider" aria-label="Provider" required>
          ${PROVIDERS.map((p) => html`<option value="${p}">${LABEL[p]} — ${shape[p]}</option>`)}
        </select>
        <input class="input mono" type="text" name="name" placeholder="name, e.g. main"
          aria-label="Name" pattern="[a-z][a-z0-9_]{0,31}" maxlength="32"
          autocomplete="off" spellcheck="false" required />
        <input class="input" type="password" name="value" placeholder="Credential"
          aria-label="Credential" autocomplete="off" required />
        ${btn("Verify and seal", { variant: "primary", size: "sm", icon: "plus" })}
      </form>
      <p class="muted small">A run that declares <span class="mono">writes: yes</span> gets no credential until you allow writes on its account.</p>
    </section>`;
}

function readsCard(reads: CloudRead[]): Html {
  return html`<section class="settings-block">
    <h2>Every read</h2>
    ${reads.length === 0
      ? html`<p class="muted small">No credential has been read yet.</p>`
      : html`<ul class="list">
          ${reads.map((r) =>
            row({
              lead: icon("eye"),
              title: html`${LABEL[r.provider]} / <span class="mono">${r.name}</span>`,
              meta: html`${runWords(r.run)} · ${time(r.at)}`,
            }),
          )}
        </ul>`}
  </section>`;
}

// GET /settings/cloud
export async function cloudPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const reads = timePhase(ctx.request, "reads", () => recentCloudReads(ctx.app.db));
  const uses = await timePhaseAsync(ctx.request, "uses", () =>
    usesByVendor(ctx.app.db, ctx.app.reposRoot, ctx.auth.user!),
  );
  const accounts = timePhase(ctx.request, "accounts", () => listCloudAccounts(ctx.app.db));
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "Cloud accounts",
    body: html`<div class="page-head"><h1>Cloud accounts</h1></div>
      ${settingsLayout(
        accountSections("cloud", { admin: true }),
        html`${accountsCard(accounts, reads, uses)}${readsCard(reads)}
          <p class="muted small"><a href="/settings/cloud/audit">Every vendor call today</a> · <a href="/deploy-to">Deploy a pinned forge</a></p>`,
        "Account settings",
      )}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
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

// GET /settings/cloud/audit
export function cloudAuditPage(ctx: Ctx): Response {
  nameFrame(ctx.request);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = requireAdmin(ctx);
  if (denied) return timePhase(ctx.request, "render", () => denied);
  const rows = timePhase(ctx.request, "audit", () => auditToday(ctx.app.db));
  return timePhase(ctx.request, "render", () => page({
    ctx,
    title: "Cloud audit",
    body: html`<div class="page-head"><h1>Cloud audit</h1></div>
      ${settingsLayout(
        accountSections("cloud", { admin: true }),
        html`<section class="settings-block">
          <h2>Today's vendor calls</h2>
          ${rows.length === 0
            ? html`<p class="muted small">No vendor call today. Rows are kept 90 days.</p>`
            : html`<ul class="list">
                ${rows.map((r) =>
                  row({
                    lead: icon(r.allowed ? "eye" : "x"),
                    title: html`${r.allowed ? "Allowed" : "Refused"}: ${isProvider(r.provider) ? LABEL[r.provider] : r.provider} /
                      <span class="mono">${r.account}</span> for ${r.purpose}`,
                    meta: html`<span class="mono">${r.target}</span> · ${r.bytesOut} bytes out · ${time(r.at)}`,
                  }),
                )}
              </ul>`}
        </section>`,
        "Account settings",
      )}`,
  }));
}

// POST /settings/cloud/rotate
export async function cloudRotate(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = await rotateAccount(ctx.app, ctx.auth.user, field(form, "provider"), field(form, "name"), field(form, "value").trim());
  return said(ctx, r, r.ok ? `Rotated. ${r.value}` : "", r.ok ? undefined : r.error);
}

// POST /settings/cloud/rename
export async function cloudRename(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const r = renameAccount(ctx.app, ctx.auth.user, field(form, "provider"), field(form, "name"), field(form, "to").trim());
  return said(ctx, r, "Renamed.", r.ok ? undefined : r.error);
}

// POST /settings/cloud/remove
export async function cloudRemove(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  // The confirm page posts to its `to` exactly, so the account arrives in the query.
  const query = ctx.url.searchParams;
  const provider = field(form, "provider") || (query.get("provider") ?? "");
  const name = field(form, "name") || (query.get("name") ?? "");
  const r = removeAccount(ctx.app, ctx.auth.user, provider, name);
  return said(ctx, r, "Removed.", r.ok ? undefined : r.error);
}
