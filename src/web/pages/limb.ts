/**
 * Acting on a whole limb from its milestone (#733): the preview before
 * anything is written, the receipt after, and the undo. Three small pages
 * over `actions/limbs.ts` — which is the fleet's own plan, receipt and undo
 * — so a person sees every issue an action touches, confirms once, and can
 * take it back once.
 */

import { isReplanAction } from "../../actions/limb_replan.ts";
import { getFleetOp, undoFleetOp } from "../../actions/fleet.ts";
import {
  applyLimb,
  isLimbAction,
  previewLimb,
  type LimbAction,
  type LimbIssue,
  type LimbRequest,
} from "../../actions/limbs.ts";
import type { FleetValue, Operation } from "../../core/fleet_ops.ts";
import { getIssuesByIds } from "../../core/issues.ts";
import { pillarsOf } from "../../core/pillars.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import {
  badge,
  btn,
  field as formField,
  listCard,
  row,
  selectField,
} from "../ui.ts";
import { replanPreviewPage, replanSubmit } from "./limb_replan.ts";
import { milestoneHref, milestonesCss } from "./milestones.ts";

const WORDS: Record<LimbAction, { ask: string; does: string; go: string }> = {
  defer: {
    ask: "Defer",
    does: "It moves behind the Later gate, out from under its pillar. The crew picks nothing beneath it until you resume it.",
    go: "Defer this limb",
  },
  resume: {
    ask: "Resume",
    does: "It comes out from behind the Later gate. What is beneath it can be picked again.",
    go: "Resume this limb",
  },
  close: {
    ask: "Close",
    does: "Every open issue that only this limb needs closes as not doing, with your reason said on each.",
    go: "Close as not doing",
  },
  raise: {
    ask: "Raise",
    does: "It moves up one place among its siblings, and the crew takes ready work from the higher limb first.",
    go: "Raise this limb",
  },
  lower: {
    ask: "Lower",
    does: "It moves down one place among its siblings, and the crew takes ready work from the higher limb first.",
    go: "Lower this limb",
  },
};

/** A seat (`top:2`) as a person reads it; anything else as it is. */
const seatWords = (token: string | number): string => {
  const place = /^(?:top|[0-9]+):([0-9]+)$/.exec(String(token))?.[1];
  return place === undefined ? String(token) : `place ${place}`;
};

const shown = (value: FleetValue): string =>
  value === null
    ? "nothing"
    : Array.isArray(value)
      ? value.length === 0
        ? "filed nowhere"
        : value.map(seatWords).join(", ")
      : String(value);

/** How many issues a list shows before the rest folds away. */
const SHOWN = 10;

function issueList(base: string, issues: readonly LimbIssue[]): Html {
  const row = (i: LimbIssue): Html =>
    html`<li>
      <a href="${base}/issues/${i.number}">${i.title}</a>
      <span class="muted small">#${i.number}</span>
    </li>`;
  return html`<ul class="ms-rows">
      ${issues.slice(0, SHOWN).map(row)}
    </ul>
    ${when(
      issues.length > SHOWN,
      () =>
        html`<details class="ms-more">
          <summary class="small">${issues.length - SHOWN} more</summary>
          <ul class="ms-rows">
            ${issues.slice(SHOWN).map(row)}
          </ul>
        </details>`,
    )}`;
}

/**
 * The rows an operation plans or wrote: each issue by its title, what it
 * held before and holds after, and how it went.
 */
function rowList(
  ctx: Ctx,
  base: string,
  rows: readonly {
    targetId: string;
    label: string;
    before: FleetValue;
    after: FleetValue;
    outcome: string;
    reason: string;
  }[],
): Html {
  const issues = getIssuesByIds(
    ctx.app.db,
    rows.map((r) => r.targetId),
  );
  return listCard(
    rows.map((r) => {
      const issue = issues.get(r.targetId);
      const settled = r.outcome === "change" || r.outcome === "ok";
      const meta = [
        ...(issue === undefined ? [] : [`#${issue.number}`]),
        `${shown(r.before)} → ${shown(r.after)}`,
        ...(settled || r.reason === "" ? [] : [r.reason]),
      ].join(" · ");
      return row({
        ...(issue === undefined
          ? { title: r.label }
          : { href: `${base}/issues/${issue.number}`, title: issue.title }),
        meta: html`<span title="${meta}">${meta}</span>`,
        ...(settled ? {} : { trail: badge(r.outcome, { tone: "attn" }) }),
      });
    }),
  );
}

function requestOf(
  action: LimbAction,
  get: (name: string) => string,
): LimbRequest {
  const reason = get("reason").trim();
  const pillar = get("pillar").trim();
  const under = get("under").trim();
  return {
    action,
    ...(reason === "" ? {} : { reason }),
    ...(pillar === "" ? {} : { pillar }),
    ...(under === "" ? {} : { under }),
  };
}

/** GET /:owner/:name/milestones/:number/limb?action= — what it will do, before it does. */
export function limbPreviewPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const number = Number(ctx.params.number);
  const action = ctx.url.searchParams.get("action");
  if (action === "replan") return replanPreviewPage(ctx, repo, number);
  if (!Number.isInteger(number) || !isLimbAction(action))
    return notFoundPage(ctx);
  const request = requestOf(action, (n) => ctx.url.searchParams.get(n) ?? "");
  // A close is planned before its reason is typed: the rows do not depend on it.
  const plan = previewLimb(ctx.app, ctx.auth.user, repo, number, {
    ...request,
    ...(action === "close" && request.reason === undefined
      ? { reason: "…" }
      : {}),
  });
  const base = repoBase(repo);
  const words = WORDS[action];
  if (!plan.ok) {
    if (plan.error.code === "not_found") return notFoundPage(ctx);
    // Too much for one operation, or an agent asking: said, not hidden.
    return page({
      ctx,
      title: `${words.ask} · ${repo.name}`,
      crumbs: crumbsFor(repo),
      palette: repoPalette(ctx, repo),
      body: html`${repoHeader(ctx, repo, "map")}
        <div class="ms-top mt">
          <h1>${words.ask} this limb?</h1>
          <p id="limb-refused">Not as one action: ${plan.error.message}.</p>
          <p><a href="${milestoneHref(base, number)}">Back</a></p>
        </div>`,
      styleCss: milestonesCss,
    });
  }
  const p = plan.value;
  const willWrite = p.counts.change > 0;
  const moving = action === "raise" || action === "lower";
  const pillars =
    action === "resume" ? pillarsOf(ctx.app.db, repo).pillars : [];
  const body = html`${repoHeader(ctx, repo, "map")}
    <div class="ms-top mt">
      <p class="small muted">
        <a href="${milestoneHref(base, number)}">${p.limb.title}</a>
      </p>
      <h1>${words.ask} “${p.limb.title}”?</h1>
      <p>${words.does}</p>
    </div>
    ${when(
      p.order !== undefined,
      () =>
        html`<section class="ms-section" id="limb-order">
          <h2>The order of the limbs</h2>
          <ol class="ms-rows">
            ${(p.order ?? []).map(
              (i) =>
                html`<li ${i.number === p.limb.number ? html`aria-current="true"` : null}>
                  ${i.number === p.limb.number
                    ? html`<b>${i.title}</b>`
                    : html`<a href="${base}/issues/${i.number}">${i.title}</a>`}
                  <span class="muted small">#${i.number}</span>
                </li>`,
            )}
          </ol>
        </section>`,
    )}
    ${when(
      p.ready !== undefined,
      () => {
        const before = (p.ready?.before ?? []).map((i) => i.number);
        const after = p.ready?.after ?? [];
        return html`<section class="ms-section" id="limb-ready">
          <h2>The top of the ready list</h2>
          ${after.length === 0
            ? html`<p class="muted small">Nothing is ready.</p>`
            : before.join() === after.map((i) => i.number).join()
              ? html`<p class="muted small">Unchanged: the same ${after.length} come first.</p>
                  ${issueList(base, after)}`
              : html`<p class="muted small">After the move, the crew takes these first:</p>
                  ${issueList(base, after)}`}
        </section>`;
      },
    )}
    ${when(
      p.taken.length > 0,
      () =>
        html`<section class="ms-section" id="limb-taken">
          <h2>
            ${action === "resume"
              ? `${p.taken.length} can be picked again`
              : `${p.taken.length} stop being picked`}
          </h2>
          ${issueList(base, p.taken)}
        </section>`,
    )}
    ${when(
      p.kept.length > 0,
      () =>
        html`<section class="ms-section" id="limb-kept">
          <h2>
            ${p.kept.length} stay${p.kept.length === 1 ? "s" : ""}: something
            outside this limb still waits for
            ${p.kept.length === 1 ? "it" : "them"}
          </h2>
          ${issueList(base, p.kept)}
        </section>`,
    )}
    ${moving
      ? null
      : html`<section class="ms-section" id="limb-rows">
          <h2>What is written</h2>
          ${p.rows.length === 0
            ? html`<p class="muted small">Nothing: no open issue is the limb's alone.</p>`
            : rowList(ctx, base, p.rows)}
        </section>`}
    ${willWrite
      ? html`<div class="mt">
          <form
            method="post"
            action="${milestoneHref(base, number)}/limb"
            class="dialog"
            aria-labelledby="limb-confirm-title"
          >
            <div class="dialog-head">
              <h2 id="limb-confirm-title">${words.go}?</h2>
            </div>
            <div class="dialog-body stack">
              <input type="hidden" name="action" value="${action}" />
              ${when(
                request.under,
                (under) =>
                  html`<input type="hidden" name="under" value="${under}" />`,
              )}
              ${when(action === "close", () =>
                formField({
                  label: "Why, in one sentence",
                  name: "reason",
                  id: "limb-reason",
                  required: true,
                  maxlength: 300,
                }),
              )}
              ${when(action === "resume", () =>
                selectField({
                  label: "Under",
                  name: "pillar",
                  id: "limb-pillar",
                  options: [
                    { value: "", label: "no pillar" },
                    ...pillars.map((pillar) => ({
                      value: pillar.short,
                      label: pillar.name,
                      selected:
                        request.pillar?.toLowerCase() ===
                        pillar.short.toLowerCase(),
                    })),
                  ],
                }),
              )}
            </div>
            <div class="dialog-foot">
              ${btn("Back", {
                href: milestoneHref(base, number),
                variant: "ghost",
              })}
              ${btn(words.go, {
                variant: action === "close" ? "danger" : "primary",
              })}
            </div>
          </form>
        </div>`
      : html`<p class="mt">
          Nothing here is yours to change.
          <a href="${milestoneHref(base, number)}">Back</a>
        </p>`}`;
  return page({
    ctx,
    title: `${words.ask} ${p.limb.title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: milestonesCss,
  });
}

/** POST /:owner/:name/milestones/:number/limb — apply, and show the receipt. */
export async function limbSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const number = Number(ctx.params.number);
  const action = field(form, "action");
  if (isReplanAction(action)) return replanSubmit(ctx, repo, number, action);
  if (!Number.isInteger(number) || !isLimbAction(action))
    return notFoundPage(ctx);
  const base = repoBase(repo);
  const op = await applyLimb(
    ctx.app,
    ctx.auth.user,
    repo,
    number,
    requestOf(action, (n) => field(form, n)),
  );
  // A refusal of the whole action (no reason given, not a person) goes back
  // to the preview, which says what is needed.
  if (!op.ok)
    return op.error.code === "not_found"
      ? notFoundPage(ctx)
      : redirect(
          `${milestoneHref(base, number)}/limb?action=${action}${(field(form, "under") ?? "") === "" ? "" : `&under=${encodeURIComponent(field(form, "under"))}`}`,
        );
  return redirect(`${milestoneHref(base, number)}/limb/${op.value.id}`);
}

/** What an operation was, in a word, for its receipt. */
function done(op: Operation): string {
  if (op.undoOf !== null) return "Undone";
  if (op.verb === "drop") return "Closed as not doing";
  if (op.verb === "place") return "Moved";
  return op.value === "later" ? "Deferred" : "Resumed";
}

/** GET /:owner/:name/milestones/:number/limb/:op — the receipt, and its undo. */
export function limbReceiptPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const number = Number(ctx.params.number);
  const found = getFleetOp(ctx.app, ctx.auth.user, ctx.params.op ?? "");
  if (!Number.isInteger(number) || !found.ok) return notFoundPage(ctx);
  const op = found.value;
  const base = repoBase(repo);
  const count = (outcome: string) =>
    op.rows.filter((r) => r.outcome === outcome).length;
  const others = op.rows.length - count("ok");
  const body = html`${repoHeader(ctx, repo, "map")}
    <div class="ms-top mt">
      <p class="small muted">
        <a href="${milestoneHref(base, number)}">Back to the milestone</a>
      </p>
      <h1>${done(op)}</h1>
      <p id="limb-receipt">
        ${count("ok")} written${others === 0 ? "" : `, ${others} left as they were`}.
      </p>
    </div>
    <section class="ms-section">
      <h2>The receipt</h2>
      ${rowList(ctx, base, op.rows)}
    </section>
    ${op.reversible && op.undoneBy === null && op.undoOf === null
      ? html`<form
          method="post"
          action="${milestoneHref(base, number)}/limb/${op.id}/undo"
          class="mt"
        >
          ${btn("Undo", { variant: "outline" })}
        </form>`
      : when(
          op.undoneBy,
          (by) =>
            html`<p class="mt small muted">
              Undone:
              <a href="${milestoneHref(base, number)}/limb/${by}">the receipt</a>.
            </p>`,
        )}`;
  return page({
    ctx,
    title: `${done(op)} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: milestonesCss,
  });
}

/** POST /:owner/:name/milestones/:number/limb/:op/undo — once. */
export async function limbUndo(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const number = Number(ctx.params.number);
  const base = repoBase(repo);
  const undone = await undoFleetOp(ctx.app, ctx.auth.user, ctx.params.op ?? "");
  if (!undone.ok && undone.error.code === "not_found") return notFoundPage(ctx);
  return redirect(
    `${milestoneHref(base, number)}/limb/${undone.ok ? undone.value.id : (ctx.params.op ?? "")}`,
  );
}
