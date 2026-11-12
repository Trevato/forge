/**
 * The Later gate in plain sight (#8700): the banner at the top of a held
 * issue, with Lift, and the route behind it. Reading is `core/gate_hold.ts`,
 * acting is `actions/gate.ts`.
 */

import { applyGateReview, reviewGate } from "../../actions/gate_review.ts";
import { liftHold } from "../../actions/gate.ts";
import { startsTicked, tallyLine, type Theme, type Triaged } from "../../core/gate_triage.ts";
import { pillarsOf } from "../../core/pillars.ts";
import { THREAD_SAYS } from "../../actions/thread_words.ts";
import { isCrew } from "../../core/agents.ts";
import { closedByReview, gateHolding, reviewedClosed } from "../../core/gate_hold.ts";
import type { Issue } from "../../core/issues.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette, signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, disclosure, time } from "../ui.ts";
import { threadContext } from "./thread.ts";

/** What the banner says about the hold, and the one button that ends it. */
export function heldBanner(ctx: Ctx, repo: Repo, issue: Issue): Html | null {
  const user = ctx.auth.user;
  const base0 = repoBase(repo);
  if (closedByReview(ctx.app.db, issue))
    return html`<div class="bar" id="held" role="note">
      <span>Closed by the <a href="${base0}/held">Later gate review</a>: not chosen. An idea that matters comes back.</span>
      ${user !== undefined && canWrite(ctx.app.db, repo, user)
        ? html`<form method="post" action="${base0}/issues/${issue.number}/lift" class="inline">
            ${btn("Revive", { type: "submit", variant: "primary", size: "sm" })}
          </form>`
        : null}
    </div>`;
  const gate = gateHolding(ctx.app.db, repo, issue);
  if (gate === undefined) return null;
  const mayLift =
    user !== undefined &&
    (canWrite(ctx.app.db, repo, user) || isCrew(ctx.app.db, repo.id, user.id));
  const base = repoBase(repo);
  return html`<div class="bar" id="held" role="note">
    <span
      >Held by the <a href="${base}/held">Later gate</a>, set
      by ${gate.authorName} ${time(gate.createdAt)}. The crew picks nothing
      here until it is lifted.</span
    >
    ${mayLift
      ? html`<form method="post" action="${base}/issues/${issue.number}/lift" class="inline">
          ${btn("Lift", { type: "submit", variant: "primary", size: "sm" })}
        </form>`
      : null}
  </div>`;
}

// POST /:owner/:name/issues/:number/lift
export async function liftHoldSubmit(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const repo = loadRepo(ctx) ?? found.repo;
  const dest = `${repoBase(repo)}/issues/${found.issue.number}`;
  const lifted = liftHold(ctx.app, ctx.auth.user, repo, found.issue);
  if (!lifted.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        lifted.error === "not_held"
          ? `#${found.issue.number} is not behind the Later gate.`
          : THREAD_SAYS.planForbidden,
    });
  return flashTo(ctx, dest, {
    message: `#${found.issue.number} is lifted from behind the Later gate.`,
  });
}

// ---- the list, and the one pass over it ----

/** One row of the review: ticked to close or merge, a keep with nothing to tick, and Lift to let it go instead. */
function reviewRow(base: string, mayLift: boolean, item: Triaged): Html {
  return html`<li class="bar">
    ${item.verdict.kind === "keep"
      ? html`<span class="small">Keep</span>`
      : html`<input type="checkbox" form="apply" name="n" value="${item.number}" ${startsTicked(item) ? "checked" : ""} aria-label="${item.verdict.kind === "merge" ? "Merge" : "Close"} #${item.number}" />`}
    <a href="${base}/issues/${item.number}">${item.title}</a>
    <span class="muted small">#${item.number} · ${item.verdict.why}</span>
    ${item.waiting > 0
      ? html`<span class="small" role="note">${item.waiting} open ${item.waiting === 1 ? "issue waits" : "issues wait"} for it: closing parks ${item.waiting === 1 ? "it" : "them"}</span>`
      : null}
    ${mayLift
      ? html`<form method="post" action="${base}/issues/${item.number}/lift" class="inline">
          ${btn("Lift", { type: "submit", size: "sm", variant: "ghost" })}
        </form>`
      : null}
  </li>`;
}

/** Themes drawn at rest; the rest fold into one "N more themes" line, so the
 * proposal's height is bounded: heading, bar, this many lines, three folds. */
export const THEMES_AT_REST = 6;

/** A group is one line: its name and its counts by verdict, opening to its issues. */
function themeLine(base: string, mayLift: boolean, t: Theme): Html {
  return disclosure(
    html`${t.name} <span class="muted small">${tallyLine(t.items)}</span>`,
    html`<ul class="stack stack-tight">${t.items.map((i) => reviewRow(base, mayLift, i))}</ul>`,
  );
}

// GET /:owner/:name/held — what the gate holds, grouped by theme, with one pass proposed
export function heldPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  const review = repo === undefined ? undefined : reviewGate(ctx.app, repo);
  if (repo === undefined || review === undefined) {
    notePhase(ctx.request, "render", 0);
    return notFoundPage(ctx);
  }
  const rendering = performance.now();
  const set = pillarsOf(ctx.app.db, repo);
  const gate = set.gate!;
  const base = repoBase(repo);
  const user = ctx.auth.user;
  const mayLift =
    user !== undefined &&
    (canWrite(ctx.app.db, repo, user) || isCrew(ctx.app.db, repo.id, user.id));
  const mayApply = user !== undefined && user.kind !== "agent" && canWrite(ctx.app.db, repo, user);
  const counts = { close: 0, keep: 0, merge: 0 };
  for (const c of review.changes) counts[c.verdict.kind]++;
  const closed = reviewedClosed(ctx.app.db, repo, set);
  const body = html`${repoHeader(ctx, repo, "issues", { compact: true })}
    <div class="page-head mt">
      <h1>Held by the Later gate</h1>
      <p class="muted small">
        ${review.held} open ${review.held === 1 ? "issue waits" : "issues wait"}
        behind <a href="${base}/issues/${gate.number}">the gate</a>, set by
        ${gate.authorName} ${time(gate.createdAt)}. The crew picks none of
        them until it is lifted.
      </p>
    </div>
    <div class="bar">
      <span class="muted small">${counts.close} to close · ${counts.keep} to keep · ${counts.merge} to merge</span>
      ${mayApply && review.changes.length > 0
        ? html`<form id="apply" method="post" action="${base}/held/apply" class="inline">
            <input type="hidden" name="digest" value="${review.digest}" />
            ${btn("Apply the ticked", { type: "submit", variant: "primary", size: "sm" })}
          </form>`
        : null}
    </div>
    <div class="stack stack-tight">
      ${review.themes.slice(0, THEMES_AT_REST).map((t) => themeLine(base, mayLift, t))}
      ${review.themes.length > THEMES_AT_REST
        ? disclosure(
            html`${review.themes.length - THEMES_AT_REST} more ${review.themes.length - THEMES_AT_REST === 1 ? "theme" : "themes"}`,
            html`<div class="stack stack-tight">${review.themes.slice(THEMES_AT_REST).map((t) => themeLine(base, mayLift, t))}</div>`,
            { small: true },
          )
        : null}
      ${disclosure(
        "How to read this",
        html`<p class="muted small">Close is the default; a keep joins a bet or a pillar's work; a merge folds a duplicate in. Nothing changes until you approve.</p>`,
        { small: true },
      )}
      ${closed.length === 0
        ? null
        : disclosure(
            html`Closed by the review <span class="muted small">${closed.length}</span>`,
            html`<ul class="stack stack-tight">
              ${closed.map(
                (i) => html`<li class="bar">
                  <a href="${base}/issues/${i.number}">${i.title}</a>
                  <span class="muted small">#${i.number}</span>
                  ${mayLift
                    ? html`<form method="post" action="${base}/issues/${i.number}/lift" class="inline">
                        ${btn("Revive", { type: "submit", size: "sm", variant: "ghost" })}
                      </form>`
                    : null}
                </li>`,
              )}
            </ul>`,
          )}
    </div>`;
  const response = page({
    ctx,
    title: `Held · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /:owner/:name/held/apply  { approved } — the proposal the person read, done
export async function heldApply(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const dest = `${repoBase(repo)}/held`;
  const approved = [...form.getAll("n")]
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 1000);
  const done = applyGateReview(ctx.app, ctx.auth.user, repo, approved, form.get("digest")?.toString());
  if (!done.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        done.error === "stale"
          ? "What the gate holds changed since you read it. Nothing was changed; read it again."
          : done.error === "forbidden"
            ? THREAD_SAYS.planForbidden
            : "There is no Later gate here.",
    });
  return flashTo(ctx, dest, { message: `Closed or merged ${done.value}.` });
}
