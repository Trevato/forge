/**
 * Account settings: personal access tokens and SSH keys. A person who signed
 * up on the web needs a way to mint a token here — for CI or scoped access —
 * without reaching for curl. The secret is shown once, at creation, and never
 * again. SSH keys are what the SSH listener authenticates against.
 */

import {
  addSshKey,
  createToken,
  deleteSshKey,
  deleteToken,
} from "../../actions/users.ts";
import { listKeys } from "../../core/keys.ts";
import { listTokens, type TokenScope } from "../../core/tokens.ts";
import type { Ctx } from "../../http/context.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { timeAgo } from "./repo.ts";

function tokensView(ctx: Ctx, freshSecret?: string): Html {
  const tokens = listTokens(ctx.app.db, ctx.auth.user!.id);
  return html`<div class="narrow-wide">
    <h1>Personal access tokens</h1>
    <p class="muted small">
      Use a token as the password when pushing over HTTPS, or as a
      <span class="mono">Bearer</span> token for the API. Your account password
      works for git too — tokens are for scoped or automated access.
    </p>

    ${when(
      freshSecret,
      (secret) =>
        html`<div class="card settings-card token-fresh">
          <strong>New token — copy it now, it won't be shown again:</strong>
          <div class="clone mono">${secret}</div>
        </div>`,
    )}
    ${tokens.length === 0
      ? html`<p class="muted small">No tokens yet.</p>`
      : html`<div class="card">
          <ul class="list">
            ${tokens.map(
              (t) =>
                html`<li>
                  <div class="row">
                    <span class="grow">
                      <strong>${t.name}</strong>
                      <span class="badge">${t.scope}</span>
                      <br />
                      <span class="muted small"
                        >created
                        ${timeAgo(t.createdAt)}${when(
                          t.lastUsedAt,
                          (at) => html` · last used ${timeAgo(at)}`,
                        )}</span
                      >
                    </span>
                    <form
                      method="post"
                      action="/settings/tokens/${t.id}/delete"
                      class="inline"
                    >
                      <button
                        class="btn"
                        data-size="sm"
                        data-variant="danger"
                        type="submit"
                      >
                        Revoke
                      </button>
                    </form>
                  </div>
                </li>`,
            )}
          </ul>
        </div>`}

    <form
      class="card settings-card hook-new"
      method="post"
      action="/settings/tokens"
    >
      <input
        class="input"
        name="name"
        placeholder="Token name (e.g. laptop, CI)"
        required
      />
      <select class="input" name="scope">
        <option value="rw">read + write</option>
        <option value="ro">read only</option>
        <option value="admin">admin</option>
      </select>
      <button class="btn" data-variant="primary" type="submit">
        Generate token
      </button>
    </form>
  </div>`;
}

// GET /settings/tokens
export function tokensPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return redirect("/signin");
  return page({
    title: "Access tokens",
    user: ctx.auth.user,
    theme: ctx.theme,
    body: tokensView(ctx),
  });
}

// POST /settings/tokens
export async function tokenCreate(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return redirect("/signin");
  // Minting a token must come from a browser session or the password — never
  // from another token (no privilege bootstrapping).
  if (ctx.auth.via !== "session" && ctx.auth.via !== "password") {
    return new Response("forbidden", { status: 403 });
  }
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const scope = field(form, "scope");
  const chosen: TokenScope = scope === "ro" || scope === "admin" ? scope : "rw";
  const minted = createToken(
    ctx.app,
    ctx.auth.user,
    field(form, "name") || "token",
    chosen,
  );
  if (!minted.ok) return redirect("/signin");
  return page({
    title: "Access tokens",
    user: ctx.auth.user,
    theme: ctx.theme,
    body: tokensView(ctx, minted.value.token),
  });
}

// POST /settings/tokens/:id/delete
export async function tokenDelete(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return redirect("/signin");
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  deleteToken(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  return redirect("/settings/tokens");
}

// ---- SSH keys ----

function keysView(ctx: Ctx, error?: string): Html {
  const keys = listKeys(ctx.app.db, ctx.auth.user!.id);
  return html`<div class="narrow-wide">
    <h1>SSH keys</h1>
    <p class="muted small">
      Keys that sign you in over SSH. Paste a public key
      (<span class="mono">~/.ssh/id_ed25519.pub</span>) — ed25519, ecdsa, or
      rsa (2048 bits or more).
    </p>

    ${when(error, (msg) => html`<p class="error-note">${msg}</p>`)}
    ${keys.length === 0
      ? html`<p class="muted small">No keys yet.</p>`
      : html`<div class="card">
          <ul class="list">
            ${keys.map(
              (k) =>
                html`<li>
                  <div class="row">
                    <span class="grow">
                      <strong>${k.name}</strong>
                      <span class="badge">${k.algo}</span>
                      <br />
                      <span class="mono small">${k.fingerprint}</span>
                      <br />
                      <span class="muted small"
                        >added
                        ${timeAgo(k.createdAt)}${when(
                          k.lastUsedAt,
                          (at) => html` · last used ${timeAgo(at)}`,
                        )}</span
                      >
                    </span>
                    <form
                      method="post"
                      action="/settings/keys/${k.id}/delete"
                      class="inline"
                    >
                      <button
                        class="btn"
                        data-size="sm"
                        data-variant="danger"
                        type="submit"
                      >
                        Remove
                      </button>
                    </form>
                  </div>
                </li>`,
            )}
          </ul>
        </div>`}

    <form class="card settings-card" method="post" action="/settings/keys">
      <label for="key-name">Name</label>
      <input
        class="input"
        id="key-name"
        name="name"
        placeholder="e.g. laptop"
      />
      <label for="key">Public key</label>
      <textarea
        class="input mono"
        id="key"
        name="key"
        rows="4"
        placeholder="ssh-ed25519 AAAA…"
        required
      ></textarea>
      <div class="form-actions">
        <button class="btn" data-variant="primary" type="submit">
          Add key
        </button>
      </div>
    </form>
  </div>`;
}

// GET /settings/keys
export function keysPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return redirect("/signin");
  return page({
    title: "SSH keys",
    user: ctx.auth.user,
    theme: ctx.theme,
    body: keysView(ctx),
  });
}

// POST /settings/keys
export async function keyCreate(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return redirect("/signin");
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const added = addSshKey(ctx.app, ctx.auth.user, {
    name: field(form, "name"),
    key: field(form, "key"),
  });
  if (!added.ok) {
    const messages: Record<string, string> = {
      invalid_key: "That doesn't look like a supported public key.",
      key_exists: "That key is already registered.",
    };
    return page(
      {
        title: "SSH keys",
        user: ctx.auth.user,
        theme: ctx.theme,
        body: keysView(ctx, messages[added.error] ?? "Something went wrong."),
      },
      422,
    );
  }
  return redirect("/settings/keys");
}

// POST /settings/keys/:id/delete
export async function keyDelete(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return redirect("/signin");
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  deleteSshKey(ctx.app, ctx.auth.user, ctx.params.id ?? "");
  return redirect("/settings/keys");
}
