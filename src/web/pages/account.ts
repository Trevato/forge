/**
 * Account settings: personal access tokens. A person who signed up on the web
 * needs a way to mint a token here — for CI or scoped access — without reaching
 * for curl. The secret is shown once, at creation, and never again.
 */

import {
  createToken,
  deleteToken,
  listTokens,
  type TokenScope,
} from "../../core/tokens.ts";
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
    ctx.app.db,
    ctx.auth.user.id,
    field(form, "name") || "token",
    chosen,
  );
  return page({
    title: "Access tokens",
    user: ctx.auth.user,
    theme: ctx.theme,
    body: tokensView(ctx, minted.token),
  });
}

// POST /settings/tokens/:id/delete
export async function tokenDelete(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return redirect("/signin");
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  deleteToken(ctx.app.db, ctx.auth.user.id, ctx.params.id ?? "");
  return redirect("/settings/tokens");
}
