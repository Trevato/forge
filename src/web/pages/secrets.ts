/**
 * Secrets, for a forge admin: the card that holds the operator's own
 * credentials — a DNS token, a bucket key — at the forge, under an
 * organization, or on a repository. The same card is drawn in all three
 * places, so the words stay one set. Values are write-only: set one, and
 * it is never shown again; the card lists names, when each was set, and
 * when something last opened it.
 */

import { listSecrets, putSecret, removeSecret } from "../../actions/secrets.ts";
import type { Ctx } from "../../http/context.ts";
import {
  notePhase,
  takeSessionTime,
  timePhase,
} from "../../core/route_timing.ts";
import {
  NAME_MAX,
  type SecretName,
  type SecretScope,
} from "../../core/secret_store.ts";
import { notFoundPage, settingsLayout, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, row, time } from "../ui.ts";
import { accountSections } from "./origins.ts";

const ERRORS: Record<string, string> = {
  invalid_name:
    "A name is capital letters, digits and underscores, starting with a letter — like CLOUDFLARE_API_TOKEN.",
  invalid_value: "A value is never empty and stays under 64 KiB.",
  invalid_scope: "That is not a place a secret can live.",
  not_found: "No such organization or repository.",
  no_such_secret: "No secret by that name there.",
};

/** The page a card sends you back to: derived, never taken from the form. */
function backTo(scope: string, ref: string): string {
  if (scope === "org") return `/${encodeURIComponent(ref)}`;
  if (scope === "repo") {
    const [owner = "", name = ""] = ref.split("/");
    return `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/settings`;
  }
  return "/settings/secrets";
}

/** The card: names, never values, and a form to set one. */
export function secretsCard(
  scope: SecretScope,
  ref: string,
  names: SecretName[],
): Html {
  const rows = names.map((s) =>
    row({
      title: html`<span class="mono">${s.name}</span>`,
      meta: html`set ${time(s.updatedAt)} ·
      ${
        s.lastReadAt === null
          ? "never used"
          : html`last used ${time(s.lastReadAt)}`
      }`,
      trail: html`<form
        class="row-actions"
        method="post"
        action="/settings/secrets/delete"
      >
        <input type="hidden" name="scope" value="${scope}" />
        <input type="hidden" name="ref" value="${ref}" />
        <input type="hidden" name="name" value="${s.name}" />
        ${btn("Remove", {
          size: "sm",
          icon: "x",
          label: `Remove ${s.name}`,
        })}
      </form>`,
    }),
  );
  return html`<section class="settings-block">
    <h2>Secrets</h2>
    <p class="muted small">Sealed values the forge hands to a run by name; the narrowest place wins.</p>
    ${when(
      rows.length > 0,
      () =>
        html`<ul class="list setting-list">
          ${rows}
        </ul>`,
    )}
    <form class="edit-row mt" method="post" action="/settings/secrets">
      <input type="hidden" name="scope" value="${scope}" />
      <input type="hidden" name="ref" value="${ref}" />
      <input
        class="input mono"
        type="text"
        name="name"
        placeholder="NAME"
        aria-label="Secret name"
        pattern="[A-Z][A-Z0-9_]*"
        maxlength="${String(NAME_MAX)}"
        autocomplete="off"
        spellcheck="false"
        required
      />
      <input
        class="input"
        type="password"
        name="value"
        placeholder="Value"
        aria-label="Value"
        autocomplete="off"
        required
      />
      ${btn("Seal", { variant: "primary", size: "sm", icon: "plus" })}
    </form>
  </section>`;
}

/** The card for a place, or nothing for anyone who is not a forge admin. */
export function secretsSection(
  ctx: Ctx,
  scope: SecretScope,
  ref: string,
): Html | null {
  const names = listSecrets(ctx.app, ctx.auth.user, scope, ref);
  return names.ok ? secretsCard(scope, ref, names.value) : null;
}

function requireAdmin(ctx: Ctx): Response | undefined {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!ctx.auth.user.isAdmin) return notFoundPage(ctx);
  return undefined;
}

/** One quiet line: whether signup asks Turnstile, and the two variables that decide it. */
function humanCheckLine(ctx: Ctx): string {
  return ctx.app.config.turnstileSecret === undefined
    ? "Signup has no human check. Set FORGE_TURNSTILE_SECRET and FORGE_TURNSTILE_SITEKEY at boot to turn it on."
    : "Signup asks Cloudflare Turnstile (FORGE_TURNSTILE_SECRET and FORGE_TURNSTILE_SITEKEY).";
}

// GET /settings/secrets
export function secretsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const card = timePhase(ctx.request, "secrets", () =>
    secretsSection(ctx, "forge", "")!,
  );
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "Secrets",
    body: html`<div class="page-head"><h1>Secrets</h1></div>
      ${settingsLayout(
        accountSections("secrets", { admin: true }),
        html`${card}
          <p class="muted small">${humanCheckLine(ctx)}</p>`,
        "Account settings",
      )}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /settings/secrets
export async function secretSet(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const scope = field(form, "scope");
  const ref = field(form, "ref");
  const name = field(form, "name").trim();
  const set = putSecret(
    ctx.app,
    ctx.auth.user,
    scope,
    ref,
    name,
    field(form, "value"),
  );
  return flashTo(
    ctx,
    backTo(scope, ref),
    set.ok
      ? { message: `${name} is sealed.` }
      : {
          tone: "danger",
          message: ERRORS[set.error] ?? "That could not be set.",
        },
  );
}

// POST /settings/secrets/delete
export async function secretDelete(ctx: Ctx): Promise<Response> {
  const denied = requireAdmin(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const scope = field(form, "scope");
  const ref = field(form, "ref");
  const name = field(form, "name");
  const removed = removeSecret(ctx.app, ctx.auth.user, scope, ref, name);
  return flashTo(
    ctx,
    backTo(scope, ref),
    removed.ok
      ? { message: `${name} is removed.` }
      : {
          tone: "danger",
          message: ERRORS[removed.error] ?? "Nothing was removed.",
        },
  );
}
