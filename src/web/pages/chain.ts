/**
 * `/:owner/forge/following`: the chain of forges this forge's own code
 * descends from, root first, one line per hop with its follow mode and how
 * far ahead it had gone (`spawn/chain.ts`), and the owner's one way out:
 * sever. A severed forge says so with the date and nothing is deleted.
 */

import { severForge } from "../../actions/follow.ts";
import { canAdmin } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { chainView, forgeLinkOf, type ChainLine } from "../../spawn/chain.ts";
import { loadRepo, notFoundPage, pageHead, repoBase, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashOrJson, page, redirect } from "../layout.ts";
import { btn, card } from "../ui.ts";

/** The events that change what the chain page says. */
export const CHAIN_LIVE = "forge.severed";

const MODE_WORDS = { "tell-me": "tells when the parent moves", "take-updates": "takes updates" } as const;

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

// GET /:owner/:name/following
export async function chainPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const view = (await carriesChain(ctx)) ? await chainView(ctx.app) : undefined;
  // Any other repository's following is the card on its home.
  if (view === undefined) return redirect(`${repoBase(repo)}#following`);
  const base = repoBase(repo);
  const owner = canAdmin(ctx.app.db, repo, ctx.auth.user);
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
