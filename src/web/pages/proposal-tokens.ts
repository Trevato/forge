/**
 * Proposal tokens on the repository settings page: one line each — child,
 * origin, expires, last used — with Revoke, and a form that mints one and
 * shows its secret once, on the flash. Writers only: anyone else sees no
 * section and their POSTs are 403.
 */

import { listProposals, mintProposal, revokeProposal } from "../../actions/proposal_tokens.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { isAccountItself, type Ctx } from "../../http/context.ts";
import { loadRepo, repoBase, repoNotFound, NOT_YOURS_TO_DO, forbiddenPage } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { btn, card, confirmAction, field as formField, icon, time } from "../ui.ts";

/** The section, or null for someone who cannot write here. */
export function proposalTokensSection(ctx: Ctx, repo: Repo): Html | null {
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return null;
  const base = repoBase(repo);
  const listed = listProposals(ctx.app, ctx.auth.user, repo);
  const tokens = listed.ok ? listed.value : [];
  return card(
    html`<p class="muted">
        A proposal token lets one named child forge read this repository's code (to fork it), push
        <code>child/&lt;name&gt;/…</code> branches here and open pulls from
        them — nothing else, and revoking it ends all of it. It lives 30 days.
      </p>
      ${tokens.length === 0
        ? html`<p class="muted">No proposal tokens.</p>`
        : html`<div class="table-scroll">
            <table class="table">
              <thead>
                <tr><th>Child</th><th>Origin</th><th>Expires</th><th>Last used</th><th></th></tr>
              </thead>
              <tbody>
                ${tokens.map(
                  (t) =>
                    html`<tr>
                      <td><strong>${t.child}</strong></td>
                      <td class="muted mono">${t.origin}</td>
                      <td class="muted">${t.expiresAt ? time(t.expiresAt) : "never"}</td>
                      <td class="muted">${t.lastUsedAt ? time(t.lastUsedAt) : "never"}</td>
                      <td>
                        ${confirmAction({
                          action: `${base}/settings/proposal-tokens/${t.id}/delete`,
                          verb: "Revoke",
                          size: "sm",
                        })}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`}
      <form method="post" action="${base}/settings/proposal-tokens">
        ${formField({ label: "Child", name: "child", mono: true, required: true, hint: "Lowercase words and hyphens." })}
        ${formField({ label: "Origin", name: "origin", mono: true, required: true, placeholder: "https://child.example.com/", hint: "Where the child lives." })}
        <div class="form-actions">${btn("Mint token", { variant: "primary" })}</div>
      </form>`,
    { head: html`${icon("key")}<h2>Proposal tokens</h2>` },
  );
}

/** The repository for a writer's POST, or the response that refuses it. */
async function writerForm(ctx: Ctx) {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  if (!canWrite(ctx.app.db, repo, ctx.auth.user))
    return forbiddenPage(ctx, "Only someone who can write to this repository can do this.");
  return { repo, form };
}

// POST /:owner/:name/settings/proposal-tokens
export async function proposalTokenMint(ctx: Ctx): Promise<Response> {
  const gate = await writerForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  // Never minted by another token: a credential cannot grow credentials.
  if (!isAccountItself(ctx.auth))
    return forbiddenPage(ctx, "A token is made from your own signed-in account, never by another token.");
  const minted = mintProposal(ctx.app, ctx.auth.user, repo, {
    child: field(form, "child"),
    origin: field(form, "origin"),
  });
  const back = `${repoBase(repo)}/settings`;
  if (!minted.ok)
    return minted.error.code === "invalid_child" || minted.error.code === "invalid_origin"
      ? flashTo(ctx, back, { tone: "danger", message: minted.error.message })
      : forbiddenPage(ctx, NOT_YOURS_TO_DO);
  // Post-redirect-get: the secret rides a one-shot flash, never the page.
  return flashTo(ctx, back, {
    message: "Proposal token minted — copy it now, it is never shown again.",
    code: minted.value.token,
  });
}

// POST /:owner/:name/settings/proposal-tokens/:id/delete
export async function proposalTokenRevoke(ctx: Ctx): Promise<Response> {
  const gate = await writerForm(ctx);
  if (gate instanceof Response) return gate;
  const revoked = revokeProposal(ctx.app, ctx.auth.user, gate.repo, ctx.params.id ?? "");
  return flashTo(ctx, `${repoBase(gate.repo)}/settings`, revoked.ok
    ? { message: "Proposal token revoked." }
    : { tone: "danger", message: "No such proposal token." });
}
