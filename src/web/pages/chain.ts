/**
 * `/:owner/forge/following`: the chain of forges this forge's own code
 * descends from, root first, one line per hop with its follow mode and how
 * far ahead it had gone (`spawn/chain.ts`), and the owner's one way out:
 * sever. A severed forge says so with the date and nothing is deleted.
 */

import { severForge } from "../../actions/follow.ts";
import { forgeProposals, proposeToParentForge, type ForgeProposal } from "../../actions/upstream.ts";
import { canAdmin, canWrite } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { chainView, forgeLinkOf, type ChainLine } from "../../spawn/chain.ts";
import { parentCredential } from "../../spawn/parent_credential.ts";
import { loadRepo, notFoundPage, pageHead, repoBase, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashOrJson, page, redirect } from "../layout.ts";
import { btn, card } from "../ui.ts";

/** The events that change what the chain page says. */
export const CHAIN_LIVE = "forge.severed,forge.proposal";

const MODE_WORDS = { "tell-me": "recorded: tell me (nothing tells it yet)", "take-updates": "recorded: take updates (nothing acts on it yet)" } as const;

function lineRow(l: ChainLine): Html {
  const where = l.host === "" ? "" : ` on ${l.host}`;
  const how =
    l.severedAt !== null
      ? `follows nothing since ${l.severedAt.slice(0, 10)}`
      : l.mode === null
        ? l.here
          ? "follows nothing"
          : "the root: follows nothing"
        : MODE_WORDS[l.mode];
  const ahead = l.ahead === null ? "" : l.ahead === 0 ? " · nothing of its own" : ` · ${l.ahead} of its own`;
  return html`<li>
    <div class="row">
      <span class="row-main">
        <span class="row-title"
          >${l.repo}${where}${l.here ? html` <span class="lineage-here">you are here</span>` : null}</span
        >
        <span class="row-meta">${how}${ahead}</span>
      </span>
    </div>
  </li>`;
}

/** Whether this repository is the forge code a spawned forge carries. */
async function carriesChain(ctx: Ctx): Promise<boolean> {
  const repo = loadRepo(ctx);
  const link = await forgeLinkOf(ctx.app);
  return repo !== undefined && link !== undefined && link.repo === `${repo.ownerName}/${repo.name}`;
}

const STATE_WORDS = { open: "open", merged: "merged", closed: "closed" } as const;

function proposalCard(base: string, proposals: readonly ForgeProposal[], writer: boolean): Html {
  return card(
    html`${proposals.length === 0
        ? html`<p class="muted">Nothing proposed to the parent forge yet.</p>`
        : html`<ul class="list" aria-label="Proposals to the parent forge">
            ${proposals.map(
              (p) => html`<li>
                <div class="row">
                  <span class="row-main">
                    <a class="row-title" href="${p.url}" rel="noopener">#${p.number} ${p.title}</a>
                    <span class="row-meta"
                      >${STATE_WORDS[p.state]}${p.reachable ? null : html` · parent unreachable`}</span
                    >
                  </span>
                </div>
              </li>`,
            )}
          </ul>`}
      ${writer
        ? html`<form method="post" action="${base}/following/propose" class="mt">
            <div class="form-actions">${btn("Propose to the parent forge", { type: "submit", icon: "merge" })}</div>
          </form>`
        : null}`,
    { head: html`<h2>Proposals</h2>` },
  );
}

// GET /:owner/:name/following
export async function chainPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const view = (await carriesChain(ctx)) ? await chainView(ctx.app) : undefined;
  // Any other repository's following is the card on its home.
  if (view === undefined) return redirect(`${repoBase(repo)}#following`);
  const base = repoBase(repo);
  const owner = canAdmin(ctx.app.db, repo, ctx.auth.user);
  const proposing = view.severedAt === null && (await parentCredential(ctx.app)) !== undefined;
  const proposals = proposing ? await forgeProposals(ctx.app, repo, Date.now(), ctx.auth.user !== undefined) : [];
  const writer = canWrite(ctx.app.db, repo, ctx.auth.user);
  return page({
    ctx,
    title: "Following",
    body: html`<div class="narrow-wide">
      ${pageHead("Following", {
        sub: "The forges this one's code descends from, root first. Numbers are as of the day each hop was made; the last is counted now.",
      })}
      <div
        id="live-chain"
        data-live="${CHAIN_LIVE}"
        data-live-repo="${repo.ownerName}/${repo.name}"
      >
      ${card(
        html`<ul class="list lineage" aria-label="Forges, root first">
          ${view.lines.map(lineRow)}
        </ul>`,
        { pad: false },
      )}
      ${proposing ? proposalCard(base, proposals, writer) : null}
      ${view.severedAt !== null
        ? html`<p class="muted" id="severed">
            This forge follows nothing since ${view.severedAt.slice(0, 10)}. Its code and history are
            all still here.
          </p>`
        : owner
          ? card(
              html`<p>
                  Severing cuts this forge's link to the one above it. Nothing is deleted and
                  nothing leaves; the fork stays yours, and the tree says it follows nothing
                  from today.
                </p>
                <form method="post" action="${base}/following/sever" class="mt">
                  <label class="form-field"
                    ><span>Type sever to continue</span>
                    <input name="confirm" required autocomplete="off" class="mono"
                  /></label>
                  <div class="form-actions">${btn("Sever", { variant: "danger", type: "submit" })}</div>
                </form>`,
              { head: html`<h2>Sever</h2>` },
            )
          : null}
      </div>
    </div>`,
  });
}

/** POST /:owner/:name/following/sever {confirm: sever}; the owner only. */
export async function severSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const to = `${repoBase(repo)}/following`;
  if (field(form, "confirm") !== "sever")
    return flashOrJson(ctx, to, { tone: "danger", message: "Type sever to confirm." });
  const cut = await severForge(ctx.app, ctx.auth.user, repo);
  if (!cut.ok)
    return flashOrJson(ctx, to, {
      tone: "danger",
      message: cut.error === "forbidden" ? "Only this forge's owner can sever it." : "This repository follows nothing.",
    });
  return flashOrJson(ctx, to, { message: `Severed: following nothing since ${cut.value.slice(0, 10)}. Nothing was deleted.` });
}

/** POST /:owner/:name/following/propose: push to the parent forge and open the pull there; a writer only. */
export async function proposeParentSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const to = `${repoBase(repo)}/following`;
  const made = await proposeToParentForge(ctx.app, ctx.auth.user, repo);
  if (!made.ok) {
    const e = made.error;
    return flashOrJson(ctx, to, {
      tone: "danger",
      message:
        e === "no_parent_forge"
          ? "This forge has no parent forge to propose to."
          : e === "nothing_to_propose"
            ? "Nothing here is ahead of the parent forge."
            : typeof e === "string"
              ? "You need write access to propose from here."
              : e.kind === "unreachable"
                ? "Parent unreachable: nothing was proposed."
                : `The parent forge did not take the proposal: ${e.reason}.`,
    });
  }
  return flashOrJson(ctx, to, {
    message: made.value.opened
      ? `Proposed to the parent forge as #${made.value.number}.`
      : `Already proposed to the parent forge as #${made.value.number}.`,
  });
}
