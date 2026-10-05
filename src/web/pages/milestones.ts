/**
 * Milestones (#731): the plan as a handful of limbs, and one limb opened.
 * `/:owner/:name/milestones` is the top of the tree — one line a limb, with
 * its weight — so the whole plan fits a phone; a line opens that milestone:
 * how far it is, who is building, what is stuck and on what, what merged
 * this week, when it lands at this week's pace, and its own limbs as lines.
 * Leaves show only on the limb they are under.
 *
 * Everything here is read from the dependency tree by `core/milestones.ts`.
 * Read-only: the page, the API and the MCP tool give the same numbers.
 */

import {
  limbJson,
  milestoneJson,
  readPlan,
  type LeafState,
  type Limb,
  type Milestone,
} from "../../core/milestones.ts";
import { PILLAR_DAYS } from "../../core/pillars.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { isWatching } from "../../core/watches.ts";
import { watchMilestone } from "../../actions/watches.ts";
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
import { html, when, type Html } from "../html.ts";
import { field, readForm } from "../form.ts";
import { page, redirect } from "../layout.ts";
import { btn, time } from "../ui.ts";

/** Where a milestone is: its own page. */
export const milestoneHref = (base: string, number: number): string =>
  `${base}/milestones/${number}`;

const dollars = (n: number): string => `$${n.toFixed(2)}`;

/** A limb's weight in words: what is beneath it, and whether it moves. */
function weightWords(limb: Limb): Html {
  const w = limb.weight;
  const parts: (string | Html)[] = [];
  if (limb.deferred) parts.push("deferred");
  parts.push(`${w.open} open`);
  if (w.building > 0) parts.push(`${w.building} building`);
  if (w.merged > 0) parts.push(`${w.merged} merged in ${PILLAR_DAYS} days`);
  if (w.spentUsd !== undefined && w.spentUsd > 0)
    parts.push(dollars(w.spentUsd));
  if (w.last !== null) parts.push(html`moved ${time(w.last)}`);
  return html`${parts.map((p, n) => html`${n > 0 ? " · " : null}${p}`)}`;
}

/** One limb as one line: a link to it, how far it is, and its weight. */
function limbLine(base: string, limb: Limb): Html {
  const w = limb.weight;
  return html`<li class="ms-limb" data-trim="${limb.trim === undefined ? "no" : "yes"}">
    <a class="ms-name" href="${milestoneHref(base, limb.issue.number)}"
      >${limb.name}</a
    >
    <span class="ms-count"><b>${w.done}</b> of ${w.total} done</span>
    <progress
      class="ms-bar"
      max="${Math.max(w.total, 1)}"
      value="${w.done}"
      aria-label="${limb.name}: ${w.done} of ${w.total} done"
    ></progress>
    <span class="ms-weight muted small">${weightWords(limb)}</span>
    ${when(
      limb.trim,
      (why) =>
        html`<span class="ms-trim small">A candidate to trim: ${why}.</span>`,
    )}
  </li>`;
}

/** GET /:owner/:name/milestones — the plan, collapsed to its limbs. */
export function milestonesPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const plan = readPlan(ctx.app.db, repo, {
    spend: canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user),
  });
  const base = repoBase(repo);
  const body = html`${repoHeader(ctx, repo, "map")}
    <div class="page-head mt">
      <h1>Milestones</h1>
      <p class="muted">
        How far each thing asked for is. Open one to see who is building it
        and what it waits for.
      </p>
    </div>
    ${plan.limbs.length === 0
      ? html`<p class="muted">
          Nothing here waits for anything yet, so there is no milestone to
          show. <a href="${base}/map">See the map</a>.
        </p>`
      : html`<ul class="ms-limbs" id="ms-limbs">
          ${plan.limbs.map((limb) => limbLine(base, limb))}
        </ul>`}`;
  return page({
    ctx,
    title: `Milestones · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: milestonesCss,
  });
}

const STATE_WORDS: Record<LeafState, string> = {
  building: "building",
  proposed: "proposed",
  ready: "ready",
  blocked: "blocked",
  done: "done",
  gone: "not doing",
};

/** A list that shows its first `shown` rows and folds the rest. */
function folded(rows: Html[], what: string, shown: number): Html {
  if (rows.length <= shown) return html`<ul class="ms-rows">${rows}</ul>`;
  return html`<ul class="ms-rows">${rows.slice(0, shown)}</ul>
    <details class="ms-more">
      <summary class="small">${rows.length - shown} more ${what}</summary>
      <ul class="ms-rows">${rows.slice(shown)}</ul>
    </details>`;
}

/**
 * Watch, or stop: one button, for a person who is signed in. Watching puts
 * the milestone's progress in their feed and tells their phone once, when
 * it lands (`core/watches.ts`).
 */
function watchButton(base: string, m: Milestone, watching: boolean): Html {
  return html`<form
    method="post"
    action="${milestoneHref(base, m.issue.number)}/watch"
    id="ms-watch"
  >
    <input type="hidden" name="watch" value="${watching ? "0" : "1"}" />
    ${watching
      ? btn("Watching", {
          size: "sm",
          icon: "check",
          title: "Stop watching: no more of it in your feed, and no word when it lands",
        })
      : btn("Watch", {
          size: "sm",
          variant: "primary",
          title: "Its progress in your feed, and one word to your phone when it lands",
        })}
  </form>`;
}

function milestoneBody(
  repo: Repo,
  m: Milestone,
  names: boolean,
  actions: Html | null,
): Html {
  const base = repoBase(repo);
  const issue = (number: number, title: string): Html =>
    html`<a href="${base}/issues/${number}">${title}</a>
      <span class="muted small">#${number}</span>`;
  const w = m.weight;
  const open = m.leaves.filter((l) => l.issue.state === "open");
  const closed = m.leaves.filter((l) => l.issue.state !== "open");
  return html`<div class="ms-top mt">
      <p class="small muted">
        <a href="${base}/milestones">Milestones</a>
      </p>
      <h1>${m.name}</h1>
      <p class="ms-head" data-trim="${m.trim === undefined ? "no" : "yes"}">
        <span class="ms-count"><b>${w.done}</b> of ${w.total} done</span>
        <progress
          class="ms-bar"
          max="${Math.max(w.total, 1)}"
          value="${w.done}"
          aria-label="${w.done} of ${w.total} done"
        ></progress>
        <span class="ms-weight muted small">${weightWords(m)}</span>
      </p>
      <p id="ms-estimate">${m.estimate}</p>
      ${when(
        m.trim,
        (why) =>
          html`<p class="ms-trim small">A candidate to trim: ${why}.</p>`,
      )}
      <p class="small muted">
        <a href="${base}/issues/${m.issue.number}"
          >Read the issue #${m.issue.number}</a
        >
      </p>
      ${when(actions, (bar) => html`<div class="bar ms-actions">${bar}</div>`)}
    </div>
    ${when(
      m.limbs.length > 0,
      () =>
        html`<section class="ms-section" id="ms-limbs">
          <h2>Limbs</h2>
          <ul class="ms-limbs">
            ${m.limbs.map((limb) => limbLine(base, limb))}
          </ul>
        </section>`,
    )}
    ${when(
      m.building.length > 0,
      () =>
        html`<section class="ms-section" id="ms-building">
          <h2>Building now</h2>
          <ul class="ms-rows">
            ${m.building.map(
              (b) =>
                html`<li>
                  ${issue(b.issue.number, b.issue.title)}
                  <span class="muted small"
                    >${names ? (b.who ?? "the crew") : "the crew"} · since
                    ${time(b.since)}</span
                  >
                </li>`,
            )}
          </ul>
        </section>`,
    )}
    ${when(
      m.blocked.length > 0,
      () =>
        html`<section class="ms-section" id="ms-blocked">
          <h2>Blocked</h2>
          ${folded(
            m.blocked.map(
              (b) =>
                html`<li>
                  ${issue(b.issue.number, b.issue.title)}
                  <span class="muted small"
                    >waits for
                    ${b.on.map(
                      (o, n) =>
                        html`${n > 0 ? ", " : null}<a
                            href="${base}/issues/${o.number}"
                            title="${o.title}"
                            >#${o.number}</a
                          >`,
                    )}</span
                  >
                </li>`,
            ),
            "blocked",
            5,
          )}
        </section>`,
    )}
    <section class="ms-section" id="ms-merged">
      <h2>Merged in ${PILLAR_DAYS} days</h2>
      ${m.merged.length === 0
        ? html`<p class="muted small">Nothing.</p>`
        : folded(
            m.merged.map(
              (pull) =>
                html`<li>
                  <a href="${base}/pulls/${pull.number}">${pull.title}</a>
                  <span class="muted small">${time(pull.at)}</span>
                </li>`,
            ),
            "merged",
            3,
          )}
    </section>
    ${when(
      m.leaves.length > 0,
      () =>
        html`<section class="ms-section" id="ms-leaves">
          <h2>Issues</h2>
          ${open.length === 0
            ? html`<p class="muted small">None open.</p>`
            : folded(
                open.map(
                  (leaf) =>
                    html`<li data-state="${leaf.state}">
                      ${issue(leaf.issue.number, leaf.issue.title)}
                      <span class="ms-state small"
                        >${STATE_WORDS[leaf.state]}</span
                      >
                    </li>`,
                ),
                "open",
                8,
              )}
          ${when(
            closed.length > 0,
            () =>
              html`<details class="ms-more">
                <summary class="small">${closed.length} closed</summary>
                <ul class="ms-rows">
                  ${closed.map(
                    (leaf) =>
                      html`<li data-state="${leaf.state}">
                        ${issue(leaf.issue.number, leaf.issue.title)}
                        <span class="ms-state small"
                          >${STATE_WORDS[leaf.state]}</span
                        >
                      </li>`,
                  )}
                </ul>
              </details>`,
          )}
        </section>`,
    )}`;
}

/** GET /:owner/:name/milestones/:number — one milestone, opened. */
export function milestonePage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const number = Number(ctx.params.number);
  const owner = canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user);
  const milestone = Number.isInteger(number)
    ? readPlan(ctx.app.db, repo, { spend: owner }).milestone(number)
    : undefined;
  if (milestone === undefined) return notFoundPage(ctx);
  const viewer = ctx.auth.user;
  const actions =
    viewer?.kind === "user"
      ? watchButton(
          repoBase(repo),
          milestone,
          isWatching(ctx.app.db, viewer.id, milestone.issue.id),
        )
      : null;
  return page({
    ctx,
    title: `${milestone.name} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body: html`${repoHeader(ctx, repo, "map")}
    ${milestoneBody(repo, milestone, owner, actions)}`,
    styleCss: milestonesCss,
  });
}

/** POST /:owner/:name/milestones/:number/watch — watch, or stop, and back to it. */
export async function milestoneWatch(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const number = Number(ctx.params.number);
  const set = watchMilestone(
    ctx.app,
    ctx.auth.user,
    repo,
    number,
    field(form, "watch") !== "0",
  );
  if (!set.ok)
    return set.error === "not_found"
      ? notFoundPage(ctx)
      : new Response("forbidden", { status: 403 });
  return redirect(milestoneHref(repoBase(repo), number));
}

/** The plan's limbs as data: `GET /api/v1/repos/:owner/:name/milestones`, and the MCP's `milestones`. */
export function milestonesJson(
  ctx: Ctx,
  repo: Repo,
): Record<string, unknown> {
  const plan = readPlan(ctx.app.db, repo, {
    spend: canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user),
  });
  return {
    repo: { owner: repo.ownerName, name: repo.name },
    limbs: plan.limbs.map(limbJson),
  };
}

/** One milestone as data, or nothing for an issue that waits for nothing. */
export function milestoneData(
  ctx: Ctx,
  repo: Repo,
  number: number,
): Record<string, unknown> | undefined {
  const owner = canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user);
  const milestone = readPlan(ctx.app.db, repo, { spend: owner }).milestone(
    number,
  );
  const viewer = ctx.auth.user;
  return milestone === undefined
    ? undefined
    : {
        repo: { owner: repo.ownerName, name: repo.name },
        ...milestoneJson(milestone, owner),
        // Whether the caller watches it; a caller who cannot has no answer.
        ...(viewer?.kind === "user"
          ? {
              watching: isWatching(ctx.app.db, viewer.id, milestone.issue.id),
            }
          : {}),
      };
}

export const milestonesCss = /* css */ `
.ms-limbs { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.ms-limb { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1px 12px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--border); }
.ms-limb:last-child { border-bottom: 0; }
.ms-name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-count { font-variant-numeric: tabular-nums; color: var(--muted-fg); white-space: nowrap; }
.ms-count b { color: var(--fg); }
.ms-bar { grid-column: 1 / -1; width: 100%; height: 4px; appearance: none; border: 0; border-radius: 2px; background: var(--border); overflow: hidden; }
.ms-bar::-webkit-progress-bar { background: var(--border); }
.ms-bar::-webkit-progress-value { background: var(--success); }
.ms-bar::-moz-progress-bar { background: var(--success); }
.ms-weight, .ms-trim { grid-column: 1 / -1; }
.ms-trim { color: var(--attn); margin: 0; }
.ms-top { display: grid; gap: 8px; max-width: 640px; }
.ms-top h1, .ms-top p { margin: 0; }
.ms-head { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
.ms-actions { margin-top: 4px; }
.ms-section { margin-top: 22px; }
.ms-section h2 { font-size: 13px; margin: 0 0 6px; }
.ms-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 14px; }
.ms-rows li > span { margin-left: 6px; }
.ms-state { color: var(--muted-fg); }
.ms-rows li[data-state="building"] .ms-state { color: var(--accent); }
.ms-rows li[data-state="blocked"] .ms-state { color: var(--attn); }
.ms-more { margin-top: 8px; }
.ms-more summary { cursor: pointer; color: var(--muted-fg); }
.ms-more .ms-rows { margin-top: 6px; }
`;
