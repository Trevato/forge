/**
 * The week (#8704): `/:owner/:name/week`, the retrospective the forge wrote
 * when the last weekly window closed, on one screen. It ends in at most three
 * proposals, each its own form: one tap by someone who writes here takes it,
 * and nothing else on the page changes anything.
 */
import { takeProposal } from "../../actions/week.ts";
import { polishSpend, polishWords } from "../../crew/small_share.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { latestRetro, takenOf, type Line, type Retro } from "../../flow/retro.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette, signInFirst } from "../chrome.ts";
import { backTo, field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashOrJson, page } from "../layout.ts";
import { btn, card, meter, row, stat } from "../ui.ts";

const lines = (base: string, ls: readonly Line[], none: string): Html =>
  ls.length === 0
    ? html`<p class="muted">${none}</p>`
    : card(
        html`<ul class="list setting-list">${ls.map((l) =>
          row({ href: `${base}/issues/${l.number}`, title: l.title, meta: html`#${String(l.number)} · ${l.why}` }),
        )}</ul>`,
        { pad: false },
      );

function screen(base: string, retro: Retro, taken: ReadonlySet<number>, writer: boolean): Html {
  const p = retro.projected;
  const shipped = retro.shipped.length;
  const acc = retro.accuracy;
  return html`<h2>What shipped</h2>
    <p>${p === null
      ? `${shipped} shipped. No projection was made for this week.`
      : `${shipped} shipped against a projection of ${p.shipLow === p.shipHigh ? p.shipHigh : `${p.shipLow} to ${p.shipHigh}`} (${p.confidence} confidence).`}</p>
    ${lines(base, retro.shipped, "Nothing shipped this week.")}
    <h2>Estimate accuracy</h2>
    <p>${acc.compared === 0
      ? "No shipped issue had an estimate to compare."
      : `${acc.inside} of ${acc.compared} shipped issues cost inside their estimated range.`}</p>
    <h2>Cost most for least</h2>
    ${lines(base, retro.costly, "Nothing open spent money this week.")}
    <h2>Stuck</h2>
    ${lines(base, retro.stuck, "Nothing is stuck.")}
    <h2>Proposed changes</h2>
    ${retro.proposals.length === 0
      ? html`<p class="muted">Nothing to propose.</p>`
      : html`<ul class="list setting-list">${retro.proposals.map((pr, idx) =>
          row({
            title: html`${pr.words}`,
            meta: html`${taken.has(idx) ? "Taken." : writer ? "Nothing changes until you tap." : "Only someone who writes here can take it."}`,
            ...(taken.has(idx) || !writer
              ? {}
              : {
                  after: html`<form method="post" action="${base}/week">
                    <input type="hidden" name="week_end" value="${retro.weekEnd}" />
                    <input type="hidden" name="idx" value="${String(idx)}" />
                    ${btn("Take it", { size: "sm" })}
                  </form>`,
                }),
          }),
        )}</ul>`}`;
}

/** Polish spent against its share: a labelled fact, with the words the terminal and the tool print under it. */
function polishCard(ctx: Ctx, repo: Repo): Html {
  const p = polishSpend(ctx.app.db, repo.id, repo.polishShare, new Date());
  return card(
    html`<div data-polish>${stat({
      label: "Polish share",
      value: `${p.percent.toFixed(1)}% of ${p.share}%`,
      title: "Agent spend in the last seven days on issues labelled polish or in the small-fixes lane, against all agent spend",
      note: html`${polishWords(p)}`,
    })}${meter(p.share === 0 ? 100 : (p.percent / p.share) * 100, `polish has used ${p.percent.toFixed(1)}% of the week's spend; its share is ${p.share}%`, p.under ? undefined : "attn")}</div>`,
  );
}

export function weekPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const base = repoBase(repo);
  const writer = ctx.auth.user !== undefined && ctx.auth.user.kind !== "agent" && canWrite(ctx.app.db, repo, ctx.auth.user);
  const retro = latestRetro(ctx.app.db, repo.id);
  const rendering = performance.now();
  const body = html`${repoHeader(ctx, repo, "issues")}
    <div class="page-head mt">
      <h1>The week</h1>
      <p class="muted">${retro === undefined
        ? "The forge writes this when the weekly window closes. None has closed yet."
        : `Written when the window ended ${retro.weekEnd.slice(0, 10)}, once, and never edited.`} <a href="${base}/next">Next up</a></p>
    </div>
    <h2>Polish this week</h2>
    ${polishCard(ctx, repo)}
    ${retro === undefined ? null : screen(base, retro, takenOf(ctx.app.db, repo.id, retro.weekEnd), writer)}`;
  const response = page({ ctx, title: `The week · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** POST /:owner/:name/week — `week_end` and `idx`: take one proposal. */
export async function weekSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = backTo(form, `${repoBase(repo)}/week`);
  const weekEnd = field(form, "week_end");
  const idx = /^[0-9]$/.test(field(form, "idx")) ? Number(field(form, "idx")) : -1;
  if (!/^\d{4}-\d\d-\d\dT[\d:.]{8,12}Z$/.test(weekEnd) || idx < 0)
    return flashOrJson(ctx, dest, { tone: "danger", message: "Say which proposal." });
  const took = takeProposal(ctx.app, ctx.auth.user, repo, weekEnd, idx);
  if (!took.ok) {
    if (took.error.kind === "not_found") return notFoundPage(ctx);
    return flashOrJson(ctx, dest, { tone: "danger", message: took.error.message });
  }
  return flashOrJson(ctx, dest, { message: took.value });
}
