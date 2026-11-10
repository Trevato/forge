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
  planStamp,
  readPlan,
  type LeafState,
  type Limb,
  type Milestone,
  type Plan,
} from "../../core/milestones.ts";
import type { Pace } from "../../core/pace.ts";
import { daySpark } from "../studio/kpi_row.ts";
import type { Database } from "bun:sqlite";
import { parseSeat, seating } from "../../core/limb_seats.ts";
import type { Issue } from "../../core/issues.ts";
import type { User } from "../../core/users.ts";
import type { LimbAction } from "../../actions/limbs.ts";
import {
  type AskToLive,
  isStructural,
  PILLAR_DAYS,
  pillarsOf,
  pillarView,
} from "../../core/pillars.ts";
import { canAdmin, canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { isWatching } from "../../core/watches.ts";
import { watchMilestone } from "../../actions/watches.ts";
import { replanResult } from "../../actions/limb_replan.ts";
import { given, pendingFor } from "../../core/limb_replan.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { cachedPlan } from "../map_cache.ts";
import { milestonePath } from "../../story/wave_plan.ts";
import { lastWaves, type LastWave } from "../../story/wave_last.ts";
import { askToLiveFor } from "../ask_to_live.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
  NOT_YOURS_TO_DO,
  forbiddenPage,
} from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { field, readForm } from "../form.ts";
import { page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { badge, btn, pill, row, time } from "../ui.ts";
import { folded, issueRow, list, wrappedRows } from "./limb_view.ts";

/** Where a milestone is: its own page. */
export const milestoneHref = milestonePath;

/** Where an action on the whole limb is previewed and confirmed (`limb.ts`). */
export const limbHref = (
  base: string,
  number: number,
  action: LimbAction | "replan",
  under?: string,
): string =>
  `${milestoneHref(base, number)}/limb?action=${action}${under === undefined ? "" : `&under=${encodeURIComponent(under)}`}`;

/**
 * Raise and Lower for a limb among its siblings in one group (`top`, or a
 * milestone's number): only the moves that change something, and nothing
 * at all where it has no sibling. For whoever administers the repository.
 */
type Mover = ((limb: Issue, group: string) => Html | null) & {
  /** The first group a limb sits in, for its own page. */
  homeOf(limb: Issue): string | undefined;
};

function moverFor(
  db: Database,
  repo: Repo,
  viewer: User | undefined,
  read: Plan["read"],
): Mover | undefined {
  if (!canAdmin(db, repo, viewer)) return undefined;
  const seats = seating(db, repo, read);
  const base = repoBase(repo);
  const at = (limb: Issue, group: string) => {
    const seat = seats
      .of(limb.id)
      .flatMap((s) => parseSeat(s) ?? [])
      .find((s) => s.group === group);
    if (seat === undefined || seats.size(group) < 2) return null;
    const up = seat.place > 1;
    const down = seat.place < seats.size(group);
    return html`<span class="bar"
      >${up
        ? btn("Raise", {
            href: limbHref(base, limb.number, "raise", group),
            size: "sm",
            variant: "ghost",
          })
        : null}${down
        ? btn("Lower", {
            href: limbHref(base, limb.number, "lower", group),
            size: "sm",
            variant: "ghost",
          })
        : null}</span
    >`;
  };
  return Object.assign(at, {
    homeOf: (limb: Issue) => parseSeat(seats.of(limb.id)[0])?.group,
  });
}

/**
 * The actions on a whole limb, for whoever administers the repository:
 * defer it (or resume it, when it is deferred), or close it as not doing.
 * Each opens its preview; nothing is written from here. The plan's own
 * furniture cannot be filed, so an umbrella offers only the close.
 */
function limbActions(
  base: string,
  m: Milestone,
  furniture: boolean,
  lead: Html | null,
  move: Html | null,
  replan: Html | null,
): Html {
  const number = m.issue.number;
  return html`<p class="bar mt" id="limb-actions">
    ${lead}
    ${move}
    ${replan}
    ${furniture
      ? null
      : m.deferred
        ? btn("Resume", {
            href: limbHref(base, number, "resume"),
            size: "sm",
            variant: "primary",
          })
        : btn("Defer", {
            href: limbHref(base, number, "defer"),
            size: "sm",
            ...(m.trim === undefined ? {} : { variant: "primary" as const }),
          })}
    ${btn("Close as not doing", {
      href: limbHref(base, number, "close"),
      size: "sm",
    })}
  </p>`;
}

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

/** How far a limb is, as a bar: the native element, named for a reader who cannot see it. */
export const progress = (done: number, total: number, label: string): Html =>
  html`<progress
    max="${Math.max(total, 1)}"
    value="${done}"
    aria-label="${label}"
  ></progress>`;

/** One limb as one row: a link to it, how far it is, and its weight. */
function limbLine(base: string, limb: Limb, move: Html | null = null): Html {
  const w = limb.weight;
  return row({
    nav: true,
    title: html`<a href="${milestoneHref(base, limb.issue.number)}"
      >${limb.name}</a
    >`,
    meta: html`${progress(w.done, w.total, `${limb.name}: ${w.done} of ${w.total} done`)}
      ${weightWords(limb)}${when(
        limb.trim,
        (why) => html` ${badge("trim", { tone: "attn" })} A candidate to trim: ${why}.`,
      )}`,
    trail: html`${pill(`${w.done} of ${w.total} done`)}${move}`,
  });
}

/** The repository's plan, kept while nothing it reads changes. */
export const planFor = (ctx: Pick<Ctx, "app"> & { request?: Request }, repo: Repo, spend: boolean, now: Date, named = true): Plan =>
  cachedPlan(
    {
      repoId: repo.id,
      stamp: planStamp(ctx.app.db, repo),
      spend,
      now,
    },
    () =>
      readPlan(ctx.app.db, repo, {
        spend,
        now,
        ...(named && ctx.request !== undefined
          ? { stretch: (name: string, ms: number) => notePhase(ctx.request!, `plan-${name}`, ms) }
          : {}),
      }),
  );

/** GET /:owner/:name/milestones — the plan, collapsed to its limbs. */
export function milestonesPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
  if (!repo) return notFoundPage(ctx);
  const spend = canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user);
  const plan = timePhase(ctx.request, "plan", () => planFor(ctx, repo, spend, new Date()));
  const base = repoBase(repo);
  const move = timePhase(ctx.request, "seats", () =>
    moverFor(ctx.app.db, repo, ctx.auth.user, plan.read),
  );
  const rendering = performance.now();
  const body = html`${repoHeader(ctx, repo, "map")}<div data-milestone>
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
      : html`<div id="ms-limbs">
          ${wrappedRows(
            plan.limbs.map((limb) =>
              limbLine(base, limb, move?.(limb.issue, "top") ?? null),
            ),
          )}
        </div>`}
    ${liveMount({ repo: base })}</div>`;
  const response = page({
    ctx,
    title: `Milestones · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    scriptJs: liveClientJs,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

const STATE_TONE: Record<LeafState, "success" | "attn" | undefined> = {
  building: "success",
  blocked: "attn",
  proposed: undefined,
  ready: undefined,
  deferred: undefined,
  done: undefined,
  gone: undefined,
};

const STATE_WORDS: Record<LeafState, string> = {
  building: "building",
  proposed: "proposed",
  ready: "ready",
  blocked: "blocked",
  deferred: "deferred",
  done: "done",
  gone: "not doing",
};

/**
 * Where a limb stands with the planner (#761): "with the planner" while it
 * waits, with a way to take it back until the planner has been given it;
 * otherwise Re-plan, for whoever administers the repository.
 */
function replanControl(
  ctx: Ctx,
  repo: Repo,
  m: Milestone,
  admin: boolean,
): Html | null {
  const base = repoBase(repo);
  const pending = pendingFor(ctx.app.db, repo, m.issue.id);
  if (pending === undefined)
    return admin && m.weight.open > 1
      ? btn("Re-plan", {
          href: limbHref(base, m.issue.number, "replan"),
          size: "sm",
          title: "Hand this limb to the planner to re-plan as fewer, larger pieces",
        })
      : null;
  return html`<span class="bar" id="ms-with-planner"
      ><b>With the planner</b>
      <span class="muted small">Nothing beneath it is picked until it answers.</span></span
    >${admin && !given(ctx.app.db, repo, pending.at)
      ? html`<form method="post" action="${milestoneHref(base, m.issue.number)}/limb">
          <input type="hidden" name="action" value="takeback" />
          ${btn("Take it back", { size: "sm", variant: "ghost" })}
        </form>`
      : null}`;
}

/** What the planner changed on this limb, once it has answered: each old issue and what replaced it. */
function replanChanged(ctx: Ctx, repo: Repo, m: Milestone): Html | null {
  const base = repoBase(repo);
  const result = replanResult(ctx.app, repo, m.issue.id);
  if (result === undefined || result.splits.length === 0) return null;
  const link = (n: { number: number; title: string }): Html =>
    html`<a href="${base}/issues/${n.number}">${n.title}</a>
      <span class="muted small">#${n.number}</span>`;
  return html`<section class="mt" id="ms-replanned">
    <h2 class="mb">Re-planned ${time(result.at)}</h2>
    ${wrappedRows(
      result.splits.map((s) =>
        row({
          title: link(s),
          meta: html`closed as split into
            ${s.into.map((p, n) => html`${n === 0 ? "" : ", "}${link(p)}`)}`,
        }),
      ),
    )}
  </section>`;
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

/** Issues closed per day with the design system's sparkline, and one line of what it means. */
function paceLine(pace: Pace): Html | null {
  if (pace.line === "") return null;
  const spark = daySpark(
    pace.closedPerDay,
    `Issues closed each day over the last ${pace.closedPerDay.length} days`,
  );
  return html`<div class="bar" id="ms-pace">
    <span class="muted">${spark}</span><span>${pace.line}</span>
  </div>`;
}

function milestoneBody(
  repo: Repo,
  m: Milestone,
  names: boolean,
  actions: Html | null,
  move?: Mover,
): Html {
  const base = repoBase(repo);
  const w = m.weight;
  // Each issue once: what is under Building now or Blocked is not listed
  // again under Issues.
  const above = new Set([
    ...m.building.map((b) => b.issue.id),
    ...m.blocked.map((b) => b.issue.id),
  ]);
  const stillOpen = m.leaves.filter((l) => l.issue.state === "open");
  const open = stillOpen.filter((l) => !above.has(l.issue.id));
  const closed = m.leaves.filter((l) => l.issue.state !== "open");
  const leafRow = (leaf: Milestone["leaves"][number], why: boolean): Html => {
    const tone = STATE_TONE[leaf.state];
    return issueRow(
      base,
      leaf.issue,
      why && leaf.why !== undefined && !m.deferred
        ? html`${leaf.why}`
        : undefined,
      badge(STATE_WORDS[leaf.state], tone === undefined ? {} : { tone }),
    );
  };
  return html`<div class="stack mt">
      <p class="small muted">
        <a href="${base}/milestones">Milestones</a>
      </p>
      <h1>${m.name}</h1>
      <div class="stack stack-tight" id="ms-progress">
        <span><b>${w.done}</b> of ${w.total} done</span>
        ${progress(w.done, w.total, `${w.done} of ${w.total} done`)}
        <span class="muted small">${weightWords(m)}</span>
      </div>
      <p id="ms-estimate">${m.estimate}</p>
      ${paceLine(m.pace)}
      ${when(
        m.trim,
        (why) => html`<p class="small">A candidate to trim: ${why}.</p>`,
      )}
      <p class="small muted">
        <a href="${base}/issues/${m.issue.number}"
          >Read the issue #${m.issue.number}</a
        >
      </p>
      ${actions}
    </div>
    ${when(
      m.limbs.length > 0,
      () =>
        html`<section class="mt" id="ms-limbs">
          <h2 class="mb">Limbs</h2>
          ${wrappedRows(
            m.limbs.map((limb) =>
              limbLine(base, limb, move?.(limb.issue, String(m.issue.number)) ?? null),
            ),
          )}
        </section>`,
    )}
    ${when(
      m.building.length > 0,
      () =>
        html`<section class="mt" id="ms-building">
          <h2 class="mb">Building now</h2>
          ${wrappedRows(
            m.building.map((b) =>
              issueRow(
                base,
                b.issue,
                html`${names ? (b.who ?? "the crew") : "the crew"} · since
                ${time(b.since)}`,
              ),
            ),
          )}
        </section>`,
    )}
    ${when(
      m.blocked.length > 0,
      () =>
        html`<section class="mt" id="ms-blocked">
          <h2 class="mb">Blocked</h2>
          ${folded(
            m.blocked.map((b) =>
              issueRow(
                base,
                b.issue,
                html`waits for
                ${b.on.map(
                  (o, n) =>
                    html`${n > 0 ? ", " : null}<a
                        href="${base}/issues/${o.number}"
                        title="${o.title}"
                        >#${o.number}</a
                      >`,
                )}`,
              ),
            ),
            "blocked",
            5,
          )}
        </section>`,
    )}
    ${when(
      m.spend,
      (spend) =>
        html`<section class="mt" id="ms-spend">
          <h2 class="mb">Cost and landed</h2>
          <p class="bar mb">
            <span><b>${dollars(spend.usd)}</b> spent</span>
            <span
              ><b>${spend.landed}</b> change${spend.landed === 1 ? "" : "s"}
              landed</span
            >
          </p>
          ${spend.costliest.length === 0
            ? html`<p class="muted small">Nothing has cost anything yet.</p>`
            : wrappedRows(
                spend.costliest.map((c) =>
                  issueRow(base, c.issue, undefined, pill(dollars(c.usd))),
                ),
              )}
        </section>`,
    )}
    <section class="mt" id="ms-merged">
      <h2 class="mb">Merged in ${PILLAR_DAYS} days</h2>
      ${m.merged.length === 0
        ? html`<p class="muted small">Nothing.</p>`
        : folded(
            m.merged.map((pull) =>
              row({
                href: `${base}/pulls/${pull.number}`,
                title: pull.title,
                meta: time(pull.at),
              }),
            ),
            "merged",
            3,
          )}
    </section>
    ${when(
      open.length > 0 || closed.length > 0 || stillOpen.length === 0,
      () =>
        html`<section class="mt" id="ms-leaves">
          <h2 class="mb">Issues</h2>
          ${open.length === 0
            ? when(
                stillOpen.length === 0 && m.leaves.length > 0,
                () => html`<p class="muted small">None open.</p>`,
              )
            : folded(
                open.map((leaf) => leafRow(leaf, true)),
                "open",
                8,
              )}
          ${when(
            closed.length > 0,
            () =>
              html`<details>
                <summary class="small muted">${closed.length} closed</summary>
                ${list(closed.map((leaf) => leafRow(leaf, false)), true)}
              </details>`,
          )}
        </section>`,
    )}`;
}

/** GET /:owner/:name/milestones/:number — one milestone, opened. */
export async function milestonePage(
  ctx: Ctx,
  now: Date = new Date(),
): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
  if (!repo) return notFoundPage(ctx);
  const number = Number(ctx.params.number);
  const owner = canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user);
  const plan = Number.isInteger(number)
    ? timePhase(ctx.request, "plan", () => planFor(ctx, repo, owner, now))
    : undefined;
  const milestone = plan?.milestone(number);
  if (plan === undefined || milestone === undefined) return notFoundPage(ctx);
  const viewer = ctx.auth.user;
  const wave = (
    await timePhaseAsync(ctx.request, "waves", () =>
      lastWaves({
        db: ctx.app.db,
        reposRoot: ctx.app.reposRoot,
        repo,
        viewer,
        plan: () => plan,
      }),
    )
  ).get(number);
  const rendering = performance.now();
  // Watch is each person's own; acting on the whole limb is for whoever
  // administers the repository. One row, Watch first.
  const watch =
    viewer?.kind === "user"
      ? watchButton(
          repoBase(repo),
          milestone,
          isWatching(ctx.app.db, viewer.id, milestone.issue.id),
        )
      : null;
  const move = moverFor(ctx.app.db, repo, viewer, plan.read);
  // Its own place: among the limbs of whichever milestone holds it first.
  const seat = move?.homeOf(milestone.issue);
  const admin = canAdmin(ctx.app.db, repo, ctx.auth.user);
  const replan = replanControl(ctx, repo, milestone, admin);
  const actions = admin
    ? limbActions(
        repoBase(repo),
        milestone,
        isStructural(pillarsOf(ctx.app.db, repo), milestone.issue.id),
        watch,
        seat === undefined ? null : (move?.(milestone.issue, seat) ?? null),
        replan,
      )
    : watch === null && replan === null
      ? null
      : html`<p class="bar mt">${watch}${replan}</p>`;
  const response = page({
    ctx,
    title: `${milestone.name} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body: html`${repoHeader(ctx, repo, "map")}<div data-milestone>
    ${milestoneBody(repo, milestone, owner, actions, move)}
    ${wave === undefined ? null : html`<ul class="list setting-list" id="ms-wave">${row({ nav: true, href: wave.href, title: `Last moved in wave ${wave.version}`, meta: html`${wave.headline}`, trail: html`${wave.date}` })}</ul>`}
    ${replanChanged(ctx, repo, milestone)}</div>
    ${liveMount({ repo: repoBase(repo) })}`,
    scriptJs: liveClientJs,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
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
      : forbiddenPage(ctx, NOT_YOURS_TO_DO);
  return redirect(milestoneHref(repoBase(repo), number));
}

/**
 * The plan's limbs as data: the MCP's `milestones` answers it whole as
 * `{ repo, limbs }`; `GET /api/v1/repos/:owner/:name/milestones` pages `limbs`
 * as `{ items, next_cursor }`.
 */
export async function milestonesJson(
  ctx: Ctx,
  repo: Repo,
): Promise<{ repo: { owner: string; name: string }; limbs: Record<string, unknown>[] }> {
  const plan = readPlan(ctx.app.db, repo, {
    spend: canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user),
  });
  const ask = askByUmbrella(ctx, repo);
  const waves = await lastWaves({
    db: ctx.app.db,
    reposRoot: ctx.app.reposRoot,
    repo,
    viewer: ctx.auth.user,
    plan: () => plan,
  });
  return {
    repo: { owner: repo.ownerName, name: repo.name },
    limbs: plan.limbs.map((limb) => ({
      ...limbJson(limb),
      ...askOf(ask, limb.issue.number),
      ...lastWaveOf(waves, limb.issue.number),
    })),
  };
}

/** The wave that last moved a milestone, as data: absent when none did. */
const lastWaveOf = (
  waves: ReadonlyMap<number, LastWave>,
  number: number,
): { lastWave?: LastWave } => {
  const w = waves.get(number);
  return w === undefined ? {} : { lastWave: w };
};

/** Each pillar's ask-to-live, by its umbrella's number: what its limb shows too. */
function askByUmbrella(
  ctx: Ctx,
  repo: Repo,
  only?: number,
): Map<number, AskToLive | null> {
  const out = new Map<number, AskToLive | null>();
  const view = pillarView(ctx.app.db, repo);
  if (view === undefined) return out;
  // A milestone that is no pillar's umbrella has none: read nothing.
  if (only !== undefined && !view.set.pillars.some((p) => p.umbrella.number === only))
    return out;
  const ask = askToLiveFor(ctx.app, repo, view, ctx.auth.user);
  for (const pillar of view.set.pillars)
    out.set(
      pillar.umbrella.number,
      ask.find((a) => a.pillar === pillar.name)?.askToLive ?? null,
    );
  return out;
}

const askOf = (ask: Map<number, AskToLive | null>, number: number) =>
  ask.has(number) ? { askToLive: ask.get(number) } : {};

/** One milestone as data, or nothing for an issue that waits for nothing. */
export async function milestoneData(
  ctx: Ctx,
  repo: Repo,
  number: number,
  now: Date = new Date(),
): Promise<Record<string, unknown> | undefined> {
  const owner = canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user);
  const plan = readPlan(ctx.app.db, repo, { spend: owner, now });
  const milestone = plan.milestone(number);
  const viewer = ctx.auth.user;
  if (milestone === undefined) return undefined;
  const waves = await lastWaves({
    db: ctx.app.db,
    reposRoot: ctx.app.reposRoot,
    repo,
    viewer,
    plan: () => plan,
  });
  return {
        repo: { owner: repo.ownerName, name: repo.name },
        ...milestoneJson(milestone, owner),
        ...askOf(askByUmbrella(ctx, repo, number), number),
        ...lastWaveOf(waves, number),
        // Whether the caller watches it; a caller who cannot has no answer.
        ...(viewer?.kind === "user"
          ? {
              watching: isWatching(ctx.app.db, viewer.id, milestone.issue.id),
            }
          : {}),
      };
}
