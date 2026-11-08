/**
 * `/:owner/forge/following`: the chain of forges this forge's own code
 * descends from, root first, one line per hop with its follow mode and how
 * far ahead it had gone (`spawn/chain.ts`), and the owner's one way out:
 * sever. A severed forge says so with the date and nothing is deleted.
 */

import { FOLLOW_MODE_REFUSALS, setFollowMode, severForge, takeForgeCode, takeForgeWords } from "../../actions/follow.ts";
import { FOLLOWS_NOTHING, PROPOSE_NEEDS_WRITE } from "../../actions/follow_words.ts";
import { forgeProposals, proposeToParentForge, type ForgeProposal } from "../../actions/upstream.ts";
import { SEVER_CONFIRM } from "../../actions/sever_invite_words.ts";
import { canAdmin, canWrite } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { chainView, FOLLOW_MODES, forgeLinkOf, type ChainLine, type FollowMode } from "../../spawn/chain.ts";
import { checkUpstream, upstreamState, upstreamWords } from "../../spawn/upstream.ts";
import { parentCredential } from "../../spawn/parent_credential.ts";
import { loadRepo, notFoundPage, pageHead, repoBase, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashOrJson, page, redirect } from "../layout.ts";
import { badge, btn, row } from "../ui.ts";

/** The events that change what the chain page says. */
export const CHAIN_LIVE = "forge.severed,forge.proposal,forge.follow_mode,forge.upstream,forge.updates_taken";

const MODE_LABELS: Record<FollowMode, string> = {
  "tell-me": "Tell me when the parent has something new",
  "take-updates": "Take the parent's updates",
};

/** The mode choice as a form: a forge's, or a plain fork's on its own page. */
export function modeForm(base: string, current: FollowMode | null, legend: string): Html {
  return html`<form method="post" action="${base}/following/mode">
      <fieldset class="form-field">
        <legend>${legend}</legend>
        ${FOLLOW_MODES.map(
          (m) => html`<label class="row"
            ><input type="radio" name="mode" value="${m}" ${m === current ? "checked" : null} />
            ${MODE_LABELS[m]}</label
          >`,
        )}
      </fieldset>
      <div class="form-actions">${btn("Save", { type: "submit" })}</div>
    </form>`;
}

function modeSection(base: string, current: FollowMode | null): Html {
  return html`<h2 class="mt">Follow mode</h2>${modeForm(base, current, "How this forge follows its parent")}`;
}

const MODE_WORDS = { "tell-me": "tell me", "take-updates": "take updates (as a pull you merge)" } as const;

function lineRow(l: ChainLine, upstream?: string): Html {
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
  return row({
    title: `${l.repo}${where}`,
    meta: html`${how}${ahead}${upstream === undefined ? null : ` · ${upstream}`}`,
    ...(l.here ? { trail: badge("you are here", { variant: "outline" }) } : {}),
    current: l.here,
  });
}

/** Whether this repository is the forge code a spawned forge carries. */
async function carriesChain(ctx: Ctx): Promise<boolean> {
  const repo = loadRepo(ctx);
  const link = await forgeLinkOf(ctx.app);
  return repo !== undefined && link !== undefined && link.repo === `${repo.ownerName}/${repo.name}`;
}

const STATE_WORDS = { open: "open", merged: "merged", closed: "closed" } as const;

function proposalSection(base: string, proposals: readonly ForgeProposal[], writer: boolean): Html {
  return html`<h2 class="mt">Proposals</h2>
    ${proposals.length === 0
      ? html`<p class="muted">Nothing proposed to the parent forge yet.</p>`
      : html`<ul class="list" aria-label="Proposals to the parent forge">
          ${proposals.map(
            (p) => html`<li>
              <div class="row">
                <span class="row-main">
                  <a class="row-title" href="${p.url}" rel="noopener">#${p.number} ${p.title}</a>
                  <span class="row-meta">${STATE_WORDS[p.state]}${p.reachable ? null : html` · parent unreachable`}</span>
                </span>
              </div>
            </li>`,
          )}
        </ul>`}
    ${writer
      ? html`<form method="post" action="${base}/following/propose" class="mt">
          <div class="form-actions">${btn("Propose to the parent forge", { type: "submit", icon: "merge" })}</div>
        </form>`
      : null}`;
}

// GET /:owner/:name/following
export async function chainPage(ctx: Ctx): Promise<Response> {
  const at = ctx.request;
  notePhase(at, "session", takeSessionTime(at));
  const repo = timePhase(at, "repo", () => loadRepo(ctx));
  if (!repo) return notFoundPage(ctx);
  const view = await timePhaseAsync(at, "chain", async () => ((await carriesChain(ctx)) ? await chainView(ctx.app) : undefined));
  // Any other repository's following is the card on its home.
  if (view === undefined) return redirect(`${repoBase(repo)}#following`);
  const base = repoBase(repo);
  const owner = canAdmin(ctx.app.db, repo, ctx.auth.user);
  const proposing =
    view.severedAt === null && (await timePhaseAsync(at, "parent", () => parentCredential(ctx.app))) !== undefined;
  const proposals = proposing
    ? await timePhaseAsync(at, "proposals", () => forgeProposals(ctx.app, repo, Date.now(), ctx.auth.user !== undefined))
    : [];
  const writer = canWrite(ctx.app.db, repo, ctx.auth.user);
  const state = await timePhaseAsync(at, "upstream", () => upstreamState(ctx.app));
  const rendering = performance.now();
  const response = page({
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
      <ul class="list" aria-label="Forges, root first">
        ${view.lines.map((l) => lineRow(l, l.here && l.mode !== null ? upstreamWords(state) : undefined))}
      </ul>
      ${writer && view.severedAt === null
        ? html`<form method="post" action="${base}/following/check" class="mt">
            <div class="form-actions">${btn("Check the parent now", { type: "submit" })}</div>
          </form>`
        : null}
      ${owner && view.severedAt === null && (state?.behind ?? 0) > 0
        ? html`<form method="post" action="${base}/following/take" class="mt">
            <div class="form-actions">
              ${btn(`Take the ${state!.behind} new commit${state!.behind === 1 ? "" : "s"}`, { type: "submit", icon: "merge" })}
            </div>
          </form>`
        : null}
      ${owner && view.severedAt === null ? modeSection(base, view.lines[view.lines.length - 1]?.mode ?? null) : null}
      ${proposing ? proposalSection(base, proposals, writer) : null}
      ${view.severedAt !== null
        ? html`<p class="muted" id="severed">
            This forge follows nothing since ${view.severedAt.slice(0, 10)}. Its code and history are
            all still here.
          </p>`
        : owner
          ? html`<h2 class="mt">Sever</h2>
              <p>
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
              </form>`
          : null}
      </div>
    </div>`,
  });
  notePhase(at, "render", performance.now() - rendering);
  return response;
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
    return flashOrJson(ctx, to, { tone: "danger", message: SEVER_CONFIRM });
  const cut = await severForge(ctx.app, ctx.auth.user, repo);
  if (!cut.ok)
    return flashOrJson(ctx, to, {
      tone: "danger",
      message: cut.error === "forbidden" ? "Only this forge's owner can sever it." : FOLLOWS_NOTHING,
    });
  return flashOrJson(ctx, to, { message: `Severed: following nothing since ${cut.value.slice(0, 10)}. Nothing was deleted.` });
}

/** POST /:owner/:name/following/check: fetch the parent's code now; a writer only. */
export async function checkSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const to = `${repoBase(repo)}/following`;
  if (!canWrite(ctx.app.db, repo, ctx.auth.user) || !(await carriesChain(ctx)))
    return flashOrJson(ctx, to, { tone: "danger", message: "You need write access to a forge that follows." });
  const state = await checkUpstream(ctx.app);
  if (state === undefined) return flashOrJson(ctx, to, { tone: "danger", message: "This forge follows nothing." });
  return flashOrJson(ctx, to, state.error === "" ? { message: upstreamWords(state) } : { tone: "danger", message: upstreamWords(state) });
}

/** POST /:owner/:name/following/take: the parent's new code as one pull; the owner only. */
export async function takeSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const to = `${repoBase(repo)}/following`;
  const took = await takeForgeCode(ctx.app, ctx.auth.user, repo);
  if (!took.ok)
    return flashOrJson(ctx, to, {
      tone: "danger",
      message: took.error === "not_following" ? FOLLOWS_NOTHING : "Only this forge's owner can take updates.",
    });
  return flashOrJson(ctx, to, takeForgeWords(took.value));
}

/** POST /:owner/:name/following/mode {mode}; the owner only. */
export async function modeSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const to = `${repoBase(repo)}/following`;
  const set = await setFollowMode(ctx.app, ctx.auth.user, repo, field(form, "mode"));
  if (!set.ok) return flashOrJson(ctx, to, { tone: "danger", message: FOLLOW_MODE_REFUSALS[set.error].message });
  return flashOrJson(ctx, to, { message: `Now following in ${set.value} mode.` });
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
              ? PROPOSE_NEEDS_WRITE
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
