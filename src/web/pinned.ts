/**
 * The Deploy to… page (#8744): a form that puts a pinned forge on the owner's
 * cloud. A link carrying `app`, `source` and `version` lands here with those
 * filled in; nothing is deployed until the admin presses the button.
 */

import type { CloudAccount } from "../core/cloud_account.ts";
import { LABEL } from "../cloud/providers.ts";
import { html, type Html } from "./html.ts";
import { btn, card, field, selectField } from "./ui.ts";

export interface DeployForm {
  name: string;
  account: string;
  app: string;
  source: string;
  version: string;
}

/** Name a new forge after the app it runs, when the link does not say. */
export const nameFor = (app: string): string => {
  const base = (app.split("/")[1] ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 40);
  return base;
};

/** The link a README or page carries: sign-in is the route's, not the link's. */
export function deployToHref(o: { app: string; source: string; version: string }): string {
  const q = new URLSearchParams({ app: o.app, source: o.source, version: o.version });
  return `/deploy-to?${q}`;
}

export function deployPage(accounts: CloudAccount[], v: DeployForm): Html {
  const usable = accounts.filter((a) => a.provider === "digitalocean" && a.writeAllowed);
  return html`<div class="page-head"><h1>Deploy to…</h1></div>
    ${card(
      html`<p class="muted small">
          A pinned forge runs one version you choose, on a DigitalOcean droplet in your account. It has no crew and
          never updates itself: it changes only when you press Update, and Rollback is one action back.
        </p>
        ${usable.length === 0
          ? html`<p class="small" role="status">No cloud account can write yet. Add a DigitalOcean account and allow writes on
              <a href="/settings/cloud">Cloud accounts</a>, then come back to this page: what the link carried is kept.</p>`
          : null}
        <form method="post" action="/deploy-to" class="stack">
              ${selectField({
                name: "account",
                label: "Cloud account",
                required: true,
                options: usable.map((a) => ({ value: a.name, label: `${LABEL[a.provider]} / ${a.name}`, selected: a.name === v.account })),
              })}
              ${field({ name: "app", label: "App", value: v.app, placeholder: "owner/name", mono: true, required: true, maxlength: 140, spellcheck: false })}
              ${field({ name: "source", label: "Source", value: v.source, placeholder: "https://…", mono: true, required: true, maxlength: 400, spellcheck: false, hint: "An https git address." })}
              ${field({ name: "version", label: "Version", value: v.version, mono: true, required: true, maxlength: 40, spellcheck: false, hint: "A full 40-character commit id or a tag like v1.2.3 — never a branch." })}
              ${field({ name: "name", label: "Name", value: v.name, mono: true, required: true, maxlength: 40, spellcheck: false, hint: "Lowercase letters, digits and dashes." })}
              ${btn("Deploy", { variant: "primary", icon: "plus" })}
            </form>`,
    )}`;
}
