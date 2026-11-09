/**
 * A deck chooses among sibling pulls: one section per open pull in a variant
 * group, with its look and its preview, and a like and a dislike that are
 * plain form posts. A swipe on touch is the same post, sent by a few lines
 * of script. A reader sees the cards and no buttons; their post is refused.
 */

import { DEFAULT_REASON, REASON_MAX, voteVariant } from "../../actions/variants.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { variantMembers, type Pull } from "../../core/pulls.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { mayView } from "../../core/sealed.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  signInFirst,
  NOT_YOURS_TO_DO,
  forbiddenPage,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { changeHref } from "../studio/nouns.ts";
import { btn } from "../ui.ts";
import { previewBlock } from "./apps.ts";
import { lookCard } from "./looks.ts";
import { parseNumber } from "./thread.ts";

const GROUP = /^[A-Za-z0-9_-]{1,64}$/;

/** The group's pulls this viewer may see, or none when it is not a group. */
function deck(ctx: Ctx, repo: Repo, group: string): Pull[] {
  if (!GROUP.test(group)) return [];
  return variantMembers(ctx.app.db, repo.id, group).filter((p) =>
    mayView(ctx.app.db, repo, p, ctx.auth.user),
  );
}

// Swipe right likes, left asks before disliking; only a mostly horizontal
// move counts, so a diagonal scroll closes nothing.
const SWIPE_JS = `for(const c of document.querySelectorAll("[data-swipe]")){let x=null,y=0;
c.addEventListener("touchstart",e=>{x=e.touches[0].clientX;y=e.touches[0].clientY},{passive:true});
c.addEventListener("touchend",e=>{if(x===null)return;const dx=e.changedTouches[0].clientX-x,dy=e.changedTouches[0].clientY-y;x=null;
if(Math.abs(dx)<90||Math.abs(dy)*3>Math.abs(dx))return;
if(dx<0&&!confirm("Dislike and close this variant?"))return;
const f=c.querySelector(dx>0?"form.like":"form.dislike");if(f)f.requestSubmit()},{passive:true})}`;

function deckCard(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  group: string,
  writer: boolean,
  lastOpen: boolean,
): Html {
  const base = repoBase(repo);
  const record = getAppByRepo(ctx.app.db, repo.id);
  const vote = `${base}/variants/${group}/${pull.number}`;
  return html`<section class="variant-card" data-swipe>
    <h2><a href="${changeHref(base, pull.number)}">#${pull.number} ${pull.title}</a></h2>
    ${record === undefined ? null : lookCard(ctx, repo, record, pull, pull.headOid)}
    ${previewBlock(ctx, repo, pull)}
    ${when(writer, () =>
      html`<div class="bar mt">
        <form class="like" method="post" action="${vote}/like">
          ${btn("Like", { icon: "check" })}
        </form>
        <form class="dislike" method="post" action="${vote}/dislike">
          <input
            name="reason"
            maxlength="${REASON_MAX}"
            placeholder="${DEFAULT_REASON}"
            aria-label="Why not this one"
          />
          ${btn("Dislike", { icon: "x" })}
        </form>
        ${when(lastOpen, () =>
          btn("Ship", { href: changeHref(base, pull.number), icon: "rocket" }),
        )}
      </div>`,
    )}
  </section>`;
}

// GET /:owner/:name/variants/:group
export function variantsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
  if (!repo) return notFoundPage(ctx);
  const group = ctx.params.group ?? "";
  const pulls = timePhase(ctx.request, "pulls", () => deck(ctx, repo, group));
  if (pulls.length === 0) return notFoundPage(ctx);
  const open = pulls.filter((p) => p.state === "open" && p.mergedAt === null);
  const writer = timePhase(ctx.request, "access", () =>
    canWrite(ctx.app.db, repo, ctx.auth.user),
  );
  const rendering = performance.now();
  const response = page({
    ctx,
    title: `Variants in ${repo.name}`,
    crumbs: crumbsFor(repo),
    scriptJs: SWIPE_JS,
    body: html`<h1>Choose among ${pulls.length} variants</h1>
      ${open.length === 0
        ? html`<p class="muted">Every variant is decided.</p>`
        : open.map((p) =>
            deckCard(ctx, repo, p, group, writer, open.length === 1),
          )}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /:owner/:name/variants/:group/:number/(like|dislike)
export const variantVoteSubmit =
  (answer: "like" | "dislike") =>
  async (ctx: Ctx): Promise<Response> => {
    const repo = loadRepo(ctx);
    if (!repo) return notFoundPage(ctx);
    if (!ctx.auth.user) return signInFirst(ctx);
    const form = await readForm(ctx, "rw");
    if (form instanceof Response) return form;
    const group = ctx.params.group ?? "";
    const number = parseNumber(ctx.params.number);
    const pull = deck(ctx, repo, group).find((p) => p.number === number);
    if (!pull) return notFoundPage(ctx);
    const dest = `${repoBase(repo)}/variants/${group}`;
    const voted = voteVariant(
      ctx.app,
      ctx.auth.user,
      repo,
      pull,
      answer,
      field(form, "reason"),
    );
    if (!voted.ok) {
      if (voted.error === "forbidden")
        return forbiddenPage(ctx, NOT_YOURS_TO_DO);
      return flashTo(ctx, dest, {
        tone: "danger",
        message:
          voted.error === "not_open"
            ? "That variant is already decided."
            : "That could not be recorded.",
      });
    }
    return flashTo(ctx, dest, {
      message: voted.value.closed ? "Closed, with your reason." : "Liked.",
    });
  };
