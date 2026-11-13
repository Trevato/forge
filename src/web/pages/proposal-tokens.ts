/**
 * Proposal tokens on the repository settings page: one line each — child,
 * origin, expires, last used — with Revoke, and a form that mints one and
 * shows its secret once, on the flash. Writers only: anyone else sees no
 * section and their POSTs are 403.
 */

import { listProposals, mintProposal, revokeProposal } from "../../actions/proposal_tokens.ts";
import { revokeOutsideToken, setOutsideContributions, takesOutside } from "../../actions/contribute_token.ts";
import { contributeOpen, listContribute } from "../../core/contribute_token.ts";
import { canAdmin, canWrite, type Repo } from "../../core/repos.ts";
import { isAccountItself, type Ctx } from "../../http/context.ts";
import { loadRepo, repoBase, repoNotFound, NOT_YOURS_TO_DO, forbiddenPage } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { liveMount } from "../live.ts";
import { flashTo } from "../layout.ts";
import { btn, confirmAction, field as formField, time } from "../ui.ts";

/**
 * Outside agents' contribute tokens (#12012): the owner's yes, and each live token
 * with Revoke (after a confirm). Admins only.
 */
function contributeTokensSection(ctx: Ctx, repo: Repo): Html | null {
  if (!canAdmin(ctx.app.db, repo, ctx.auth.user)) return null;
  const base = repoBase(repo);
  const open = contributeOpen(ctx.app.db, repo.id);
  const tokens = open ? listContribute(ctx.app.db, repo.id, new Date()) : [];
  return html`<section class="settings-block mb" id="contribute-tokens">
    <form method="post" action="${base}/settings/contribute-tokens/open">
      <input type="hidden" name="on" value="${open ? "0" : "1"}" />
      <p class="muted"><strong>Outside agents</strong> with their own sandbox may ask for a token that lasts a day, push <code>contrib/&lt;name&gt;/…</code> branches here and open pulls, with no account. Names and origins are claimed, not verified.${open && !takesOutside(ctx.app, repo)
        ? " Not offered now: only a public, original, unarchived repository takes them."
        : ""} ${btn(open ? "Stop allowing" : "Allow", { variant: open ? "secondary" : "primary", size: "sm" })}</p>
    </form>
    ${tokens.length === 0
      ? null
      : html`<dl class="status-rows">
          ${tokens.map(
            (t) => html`<div class="status-row">
              <dt>${t.agent}</dt>
              <dd>
                <span class="mono">${t.origin === "" ? "no origin given" : t.origin}</span>
                <span class="muted">· claimed, not verified · expires ${time(t.expiresAt)} · last used ${t.lastUsedAt ? time(t.lastUsedAt) : "never"}</span>
              </dd>
              <dd class="status-act">
                ${confirmAction({ action: `${base}/settings/contribute-tokens/${t.id}/delete`, verb: "Revoke", size: "sm" })}
              </dd>
            </div>`,
          )}
        </dl>`}
  </section>`;
}

/** The section, or null for someone who cannot write here. */
export function proposalTokensSection(ctx: Ctx, repo: Repo): Html | null {
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return null;
  const outside = contributeTokensSection(ctx, repo);
  const base = repoBase(repo);
  const listed = listProposals(ctx.app, ctx.auth.user, repo);
  const tokens = listed.ok ? listed.value : [];
  return html`${outside}${outside === null ? null : liveMount({ repo: base })}<section class="settings-block" id="proposal-tokens">
    <h2>Proposal tokens</h2>
    <p class="muted">Lets one child forge fork this code, push <code>child/&lt;name&gt;/…</code> branches and open pulls. Lasts 30 days.</p>
    ${tokens.length === 0
      ? null
      : html`<dl class="status-rows">
          ${tokens.map(
            (t) => html`<div class="status-row">
              <dt>${t.child}</dt>
              <dd>
                <span class="mono">${t.origin}</span>
                <span class="muted">· expires ${t.expiresAt ? time(t.expiresAt) : "never"} · last used ${t.lastUsedAt ? time(t.lastUsedAt) : "never"}</span>
              </dd>
              <dd class="status-act">
                ${confirmAction({
                  action: `${base}/settings/proposal-tokens/${t.id}/delete`,
                  verb: "Revoke",
                  size: "sm",
                })}
              </dd>
            </div>`,
          )}
        </dl>`}
    <form method="post" action="${base}/settings/proposal-tokens" class="stack">
      ${formField({ label: "Child", name: "child", mono: true, required: true, hint: "Lowercase words and hyphens." })}
      ${formField({ label: "Origin", name: "origin", mono: true, required: true, placeholder: "https://child.example.com/" })}
      <div class="form-actions">${btn("Mint token", { variant: "primary" })}</div>
    </form>
  </section>`;
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

// POST /:owner/:name/settings/contribute-tokens/open
export async function contributeOpenSet(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const on = field(form, "on") === "1";
  const set = setOutsideContributions(ctx.app, ctx.auth.user, repo, on);
  if (!set.ok) return forbiddenPage(ctx, NOT_YOURS_TO_DO);
  return flashTo(ctx, `${repoBase(repo)}/settings`, {
    message: on ? "Outside agents may ask for a token for this repository." : "Outside agents may no longer ask for a token. Tokens already made still work until revoked.",
  });
}

// POST /:owner/:name/settings/contribute-tokens/:id/delete
export async function contributeTokenRevoke(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  if (!canAdmin(ctx.app.db, repo, ctx.auth.user)) return forbiddenPage(ctx, NOT_YOURS_TO_DO);
  const revoked = revokeOutsideToken(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "");
  return flashTo(ctx, `${repoBase(repo)}/settings`, revoked.ok
    ? { message: "Outside agent's token revoked." }
    : { tone: "danger", message: "No such token." });
}
