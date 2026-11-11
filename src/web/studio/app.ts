/**
 * The app in the studio: one page per app, and the front door a person acts
 * from — the box they tell the crew in, what asks them, and Now, one row per
 * thing the crew has in hand in the studio's own words — with every
 * environment's controls: production's and each preview's Redeploy and Stop
 * (`previews.ts`), and the way to the app's environment settings. Dev's old
 * App URL (`GET /:owner/:name/app`) lands here. Money, the crew roster,
 * autonomy and the decision ledger are the owner's facts and render only
 * for a viewer who can write here; a stranger sees the app.
 */

import { appCardPath } from "../og/path.ts";
import { fleetGraphHref } from "../fleet-graph.ts";
import { sealedScope } from "../../core/sealed.ts";
import { egressSetting } from "../../core/capacity.ts";
import { egressNote } from "./egress.ts";
import { audit } from "../../contract/audit.ts";
import { latestProbes } from "../../contract/probes.ts";
import { appsRuntime, envsFor } from "../../apps/runtime.ts";
import { MAX_BODY } from "../../core/issues.ts";
import { listCrewRoles } from "../../core/agents.ts";
import type { AppRecord } from "../../core/apps.ts";
import { decisionStats, type DecisionStat } from "../../core/decisions.ts";
import { listPulls, mergedPullCount } from "../../core/pulls.ts";
import { canAdmin, canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import {
  agentRunTotals,
  previewLatency,
  type PreviewLatency,
} from "../../core/runs.ts";
import { autonomyStatus } from "../../crew/autonomy.ts";
import { governorSeen } from "../../crew/governed.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { appTailJs, liveRegionsJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { appLine } from "../describe.ts";
import { page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  archivedParentLine,
  followingCard,
  followingOf,
} from "../pages/following.ts";
import {
  avatar,
  badge,
  btn,
  card,
  envPhrase,
  icon,
  listCard,
  row,
} from "../ui.ts";
import { answersRegion } from "./answers.ts";
import { appMilestones } from "./milestone_lines.ts";
import { nowCard, nowRegion } from "./now.ts";
import { repoAsks } from "./asks.ts";
import { notesCard } from "./notes.ts";
import { adapterCard } from "./adapter.ts";
import { appPanels } from "./previews.ts";
import { noCrewLine, pausedWords, servingHistory, type WordCtx } from "./words.ts";
import { crewKeyCard } from "./crew_key.ts";
import {
  notePhase,
  takeSessionTime,
  timePhase,
  timePhaseAsync,
} from "../../core/route_timing.ts";
import { noteAppOpened } from "../../core/next-steps.ts";
import { readAppMoney } from "../../actions/money.ts";
import { moneyRows } from "./money_line.ts";

/**
 * What asks the viewer in this repository, muted or not: a mute quiets the
 * home, the inbox and the phone, never the repository's own page.
 */
function askingLine(ctx: Ctx, repo: Repo): Html | null {
  const { count, muted } = repoAsks(ctx.app.db, ctx.auth.user, repo);
  if (count === 0) return null;
  return html`<p class="small muted" id="repo-asks">
    ${count} ${count === 1 ? "thing asks" : "things ask"} you here${muted ? " (muted from your home)" : ""}.
  </p>`;
}

/**
 * The week's decisions in one line: how many, how many the decider took
 * rather than the rule, and what came of the ones that are known.
 * "12 · 11 by typesafe · shipped 5, shown 2, stopped 1"
 */
function decisionWords(stats: readonly DecisionStat[]): Html {
  const n = stats.reduce((s, k) => s + k.n, 0);
  const decided = stats.reduce((s, k) => s + k.decided, 0);
  const by = stats
    .flatMap((k) => Object.entries(k.outcomes))
    .reduce<Record<string, number>>((acc, [o, c]) => {
      acc[o] = (acc[o] ?? 0) + c;
      return acc;
    }, {});
  const outcomes = Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .map(([o, c]) => `${o} ${c}`)
    .join(", ");
  return html`${n}
    <span class="muted"
      >· ${decided} by the
      decider${outcomes === "" ? "" : ` · ${outcomes}`}</span
    >`;
}

/** Below this many served deploys a median is one or two points, not a trend. */
const PREVIEW_LATENCY_MIN = 3;

/**
 * Below this many deploys total (served and never-served together) a
 * failure ratio is one unlucky boot, not a rate worth a red link — the
 * app's own first couple of production deploys should never read as a
 * statistic.
 */
const FAILED_RATIO_MIN = 5;

/**
 * How fast a change has reached its preview this week, worded like the
 * reference instant in `servedPhrase` (`web/ui.ts`): "reaches its preview
 * in 6.1s". Too few served deploys to trust a median, and the line says so
 * rather than printing one from a run or two. Below the total, the same
 * walk split at `started_at` — waiting to be picked up, then coming up —
 * each its own median, not a piece of the total that ought to add up.
 * When some of the week's deploys finished without ever serving, the line
 * says how many of how many and links to them — a clean week reads exactly
 * as it always has, no `0 failed`, no empty clause. Below `FAILED_RATIO_MIN`
 * total deploys the ratio says nothing a person should act on, so it stays
 * quiet rather than reading a young app's own first boot or two as a rate.
 */
function previewLatencyWords(
  latency: PreviewLatency | undefined,
  failedHref: string,
): Html {
  const failedTotal = latency === undefined ? 0 : latency.n + latency.failedN;
  const failedClause =
    latency !== undefined &&
    latency.failedN > 0 &&
    failedTotal >= FAILED_RATIO_MIN
      ? html`<a href="${failedHref}"
          >${latency.failedN} of ${failedTotal} never reached a preview</a
        >`
      : null;
  const failedSuffix = failedClause === null ? "" : html` · ${failedClause}`;
  if (
    latency === undefined ||
    latency.n < PREVIEW_LATENCY_MIN ||
    latency.medianSeconds === undefined
  )
    return html`<span class="muted small"
      >not enough deploys this week to say${failedSuffix}</span
    >`;
  const split =
    latency.queueMedianSeconds === undefined ||
    latency.bootMedianSeconds === undefined
      ? null
      : html`${`${latency.queueMedianSeconds.toFixed(1)}s waiting, ${latency.bootMedianSeconds.toFixed(1)}s coming up${latency.splitN < latency.n ? ` (${latency.splitN} of ${latency.n})` : ""}`}
        · `;
  return html`reaches its preview in ${latency.medianSeconds.toFixed(1)}s
    <span class="muted">· ${split}${latency.n} deploys${failedSuffix}</span>`;
}

/** The policy line's card: `setting-list` lets the title wrap and the trail drop under it on a phone. */
function policyLineCard(line: Html): Html {
  return card(html`<ul class="list setting-list">${line}</ul>`, { pad: false });
}

/**
 * One line about the app's policy, when it has one: what it opens to
 * anyone and what the running app said when the forge last knocked, with
 * the way to the audit, where the whole table is. An app without a
 * contract says nothing here; its doors are not the forge's to describe.
 */
async function policyLine(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
): Promise<Html> {
  const { standing } = await audit(ctx.app.reposRoot, repo);
  if (standing.kind === "unread") return html``;
  const href = `/audit#${repo.ownerName}-${repo.name}`;
  if (standing.kind === "unsound")
    return policyLineCard(
      row({
        lead: icon("alert"),
        title: html`<b>Its contract does not read</b>, so an app built on it
          does not boot.`,
        trail: html`<a href="${href}">See why</a>`,
      }),
    );
  const last = latestProbes(ctx.app.db, [record.id]).get(record.id);
  const open = standing.open.length;
  const said =
    last === undefined
      ? "not yet knocked on"
      : last.verdict === "ok"
        ? "obeys its table"
        : last.verdict === "mismatch"
          ? `${last.said.length === 1 ? "one door disobeys" : `${last.said.length} doors disobey`} its table`
          : last.verdict === "down"
            ? "was not running when knocked on"
            : "has no door to knock on";
  const resources = Object.keys(standing.contract.resources).length;
  const tone =
    last?.verdict === "ok"
      ? "success"
      : last?.verdict === "mismatch"
        ? "danger"
        : "default";
  const short =
    last === undefined
      ? "not knocked"
      : last.verdict === "ok"
        ? "obeys"
        : last.verdict === "mismatch"
          ? "disobeys"
          : last.verdict === "down"
            ? "down"
            : "no door";
  return policyLineCard(
    row({
      lead: icon("shield"),
      title: html`<b>${resources === 1 ? "One resource" : `${resources} resources`}</b>,
        ${open === 0
          ? "nothing open to anyone"
          : open === 1
            ? "one door open to anyone"
            : `${open} doors open to anyone`}`,
      meta: html`${said}`,
      trail: html`${badge(short, { tone })}
        <a href="${href}">The table</a>`,
    }),
  );
}

export async function studioApp(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
): Promise<Response> {
  const db = ctx.app.db;
  const req = ctx.request;
  notePhase(req, "session", takeSessionTime(req));
  const base = repoBase(repo);
  // Money, the crew roster, autonomy limits and the decision ledger are the
  // owner's facts, not the app's — a viewer who cannot write here reads this
  // page as a stranger, whatever else they can see of the repository.
  const ownerFacts = canSeeOwnerFacts(db, repo, ctx.auth.user);
  // The owner of a spawned forge (or their everyday account) opening an
  // app: their second first step. A write during a GET, on purpose: opening
  // the app IS the step, and a beacon would miss a person without
  // JavaScript. It is one user_setting row, written once, only on a spawned
  // forge, only for its owner, and changes nothing anyone else sees.
  await timePhaseAsync(req, "opened", () =>
    noteAppOpened(ctx.app, ctx.auth.user),
  );
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record,
    history: servingHistory(),
    viewer: ctx.auth.user,
  };
  const crew = timePhase(req, "crew", () => listCrewRoles(db, repo.id));
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent);
  const openPulls = timePhase(req, "pulls", () =>
    listPulls(db, repo.id, {
      state: "open",
      limit: 10,
      ...sealedScope(db, repo, ctx.auth.user),
    }),
  );
  // A new app that has not run is told apart from one with a past in
  // `appPanels` (`fresh.ts`): its page shows only its progress, so the
  // week's reads below are skipped for it.
  const { head, previews, deployTailing, fresh, history } = timePhase(req, "panels", () =>
    appPanels(ctx, repo, record, openPulls),
  );
  const week = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  // What landed this week, counted by the database like the runs and the
  // spend below — a page of closed pulls would stop at a hundred and the
  // cost per shipped change would read high off the short count.
  const shipped = fresh
    ? 0
    : timePhase(req, "shipped", () => mergedPullCount(db, repo.id, week));
  // The rest is spend, worked out only for a viewer who is going to see it —
  // counted by the database over the whole week, not off a page of rows.
  const weekTotals = ownerFacts && !fresh
    ? timePhase(req, "spend", () => agentRunTotals(db, repo.id, week))
    : { runs: 0, spentUsd: 0 };
  const spent = weekTotals.spentUsd;
  const ledgerWeek = ownerFacts && !fresh
    ? timePhase(req, "decisions", () => decisionStats(db, repo.id, week))
    : [];
  const weekLatency = ownerFacts && !fresh
    ? timePhase(req, "latency", () => previewLatency(db, repo.id, week))
    : undefined;
  const autonomy =
    !ownerFacts || fresh || repo.autonomy === "off"
      ? undefined
      : timePhase(req, "autonomy", () => autonomyStatus(ctx.app, repo));
  // The governor's reason, one line on the crew card (#7644).
  const governor = fresh
    ? undefined
    : timePhase(req, "governor", () => governorSeen(ctx.app, ctx.auth.user, repo, new Date()));

  // ---- the app itself ----
  // `deployTailing` says the head card is tailing production's own deploy —
  // the "Now" panel's empty-state words below care about that distinction.

  // ---- the box ----
  // Telling the crew, and who takes it, is the owner's own front door — a
  // stranger sees the app, not who is behind it.
  const tell = !ownerFacts
    ? null
    : html`<form class="bar tell-box" method="post" action="${base}/tell">
        <label class="sr-only" for="tell">Tell the crew</label>
        <input
          class="input"
          id="tell"
          name="text"
          required
          maxlength="${MAX_BODY}"
          placeholder="Tell the crew…"
        />
        ${btn("Tell", { variant: "primary", type: "submit" })}
      </form>
      ${builders.length === 0
        ? html`<p class="muted small">
            Nobody on the crew yet.
            <a href="${base}/settings#crew">Add a crew member under Settings → Crew</a>,
            then tell them what you want.
          </p>`
        : null}`;

  // ---- now: one row per thing, in the five words (studio/now.ts) ----
  const { card: now } = await timePhaseAsync(req, "now", () =>
    nowCard(ctx, repo, record, {
      openPulls,
      builderCount: builders.length,
      ownerFacts,
      wordCtx,
      deployTailing,
      previewLinks: fresh,
    }),
  );

  // ---- the rail ----
  // Crew, spend and autonomy are the owner's facts; a viewer who cannot
  // write here gets only the shipped count, never the roster, the money or
  // the ledger — and the page never asks for the rest on their behalf.
  // No crew yet: the tell box and the Now row already say so, once.
  const crewCard = !ownerFacts || crew.length === 0
    ? null
    : listCard(
          crew.map((c) =>
            row({
              lead: avatar(c.agent.user.username),
              title: c.agent.user.username,
              meta: html`${c.role === "builder"
                ? "builds"
                : c.role === "planner"
                  ? "plans"
                  : "reviews"}`,
            }),
          ),
          {
            head: html`${icon("bot")}
              <h2>Crew</h2>
              <span class="spacer"></span>
              ${btn("Change", { href: `${base}/settings`, size: "sm" })}`,
          },
        );
  // No history, no card: an empty week explains itself to nobody.
  const weekCard = !history ? null : card(
    !ownerFacts
        ? html`<dl>
            <dt>Shipped</dt>
            <dd>${shipped} pull request${shipped === 1 ? "" : "s"}</dd>
          </dl>`
        : html`<dl>
            <dt>Shipped</dt>
            <dd>${shipped} pull request${shipped === 1 ? "" : "s"}</dd>
            <dt>Runs</dt>
            <dd>${weekTotals.runs}</dd>
            <dt>Preview</dt>
            <dd>
              ${previewLatencyWords(weekLatency, `${base}/runs?kind=deploy`)}
            </dd>
            <dt>Spent</dt>
            <dd>
              $${spent.toFixed(2)}${shipped > 0
                ? html` <span class="muted"
                    >· $${(spent / shipped).toFixed(2)} per shipped pull request</span
                  >`
                : null}
            </dd>
            ${when(
              ledgerWeek.length > 0,
              () =>
                html`<dt>Decided</dt>
                  <dd>${decisionWords(ledgerWeek)}</dd>`,
            )}
          </dl>`,
    {
      head: html`${icon("activity")}
        <h2>This week</h2>`,
      extra: "about",
    },
  );
  const ownCard = !ownerFacts
    ? null
    : card(
        autonomy === undefined
          ? html`<p class="muted small">
              Off. <a href="${base}/settings">Turn it on</a> and the crew works
              what is ready without being asked.
            </p>`
          : html`<dl>
                <dt>Mode</dt>
                <dd>
                  ${repo.autonomy === "autonomous" ? "Autonomous" : "Assisted"}
                </dd>
                <dt>Today</dt>
                <dd>
                  $${autonomy.spentTodayUsd.toFixed(2)} of
                  $${autonomy.ceilingUsd.toFixed(0)}
                </dd>
                <dt>Slots</dt>
                <dd>${autonomy.active} of ${autonomy.slots} in use</dd>
                ${governor === undefined
                  ? null
                  : html`<dt>Governor</dt>
                      <dd>${governor.why}</dd>`}
                ${autonomy.paused
                  ? html`<dt>Paused</dt>
                      <dd>${pausedWords(autonomy.paused)}</dd>`
                  : null}
              </dl>
              ${when(crew.length === 0, () => noCrewLine(`${base}/settings`))}`,
        {
          head: html`${icon("play")}
            <h2>On its own</h2>
            <span class="spacer"></span>
            ${btn("Graph", {
              href: fleetGraphHref([`${repo.ownerName}/${repo.name}`]),
              size: "sm",
              variant: "secondary",
            })}
            ${btn("Change", { href: `${base}/settings`, size: "sm" })}`,
          extra: "about",
        },
      );
  // This month's money (#510): the statement's total against what the app
  // cost, for whoever may read its statement — the same numbers, one door.
  const money = fresh ? null : timePhase(req, "money", () => readAppMoney(ctx.app, ctx.auth.user, repo));
  const moneyCard =
    money === null || !money.ok
      ? null
      : card(moneyRows(money.value, `${base}/settings/app/statement`), {
          head: html`${icon("activity")}
            <h2>This month</h2>`,
          extra: "about",
        });
  // The rest of the app's environment — its variables, hostname, access and
  // domains — is the admin's, on the app's settings page.
  // Issues, Pulls and the map are the head's own tabs; only what it lacks is here.
  const more = html`<p class="muted small">
    <a href="${base}/variants">Variants</a>
    ${when(canAdmin(db, repo, ctx.auth.user), () => html`<a href="${base}/settings/app">Environment settings</a>`)}
    ${when(canAdmin(db, repo, ctx.auth.user), () => html`<a href="/-/confirm?to=${encodeURIComponent(`${base}/archive`)}">Archive</a>`)}
  </p>`;

  // An app that follows another says so before anything else: whether it
  // is in step is the first thing its owner wants to know.
  const following = await timePhaseAsync(req, "following", () =>
    followingOf(ctx, repo),
  );
  const policy = fresh
    ? null
    : await timePhaseAsync(req, "policy", () => policyLine(ctx, repo, record));
  const adapter = ownerFacts
    ? await timePhaseAsync(req, "adapter", () => adapterCard(ctx, record, repo))
    : null;
  const rendering = performance.now();
  const tellRegion = html`${tell}
        ${ownerFacts && ctx.auth.user ? answersRegion(ctx, repo, ctx.auth.user) : null}`;
  // A new app that has not run yet shows only its progress: the head's
  // state line, the box to tell the crew, and Now. Everything else waits
  // until there is something to show.
  const body = fresh
    ? html`${repoHeader(ctx, repo, "app", { compact: true, ownTitle: true })}
    ${following === undefined
      ? archivedParentLine(ctx, repo)
      : followingCard(ctx, repo, following)}
    <div id="app-head">${head}</div>
    ${ownerFacts ? crewKeyCard(ctx, true) : null}
    <div class="stack">
      ${adapter}
      ${tellRegion}
      <div id="app-previews"></div>
      ${nowRegion(repo, now)}
      ${appMilestones(ctx, repo)}
      ${more}
    </div>
    ${liveMount({ repo: base, app: true })}`
    : html`${repoHeader(ctx, repo, "app", {
      compact: true,
      ownTitle: true,
    })}
    ${following === undefined
      ? archivedParentLine(ctx, repo)
      : followingCard(ctx, repo, following)}
    <div id="app-head">${head}</div>
    ${askingLine(ctx, repo)}
    ${policy}
    ${ownerFacts ? crewKeyCard(ctx, true) : null}
    ${ownerFacts
      ? egressNote(
          ctx.app.config.dataDir,
          repo.id,
          appsRuntime(ctx.app)?.liveFor(record, "production")?.cell?.egress ??
            [],
          egressSetting(ctx.app.db),
        )
      : null}
    <div class="split" data-rail="wide">
      <div class="stack">
        ${tellRegion}
        <div id="app-previews">${previews}</div>
        ${nowRegion(repo, now)}
        ${appMilestones(ctx, repo)}
        ${notesCard(ctx, repo, record)}
      </div>
      <aside class="stack">
        ${adapter} ${crewCard} ${weekCard} ${moneyCard} ${ownCard} ${more}
      </aside>
    </div>
    ${liveMount({ repo: base, app: true })}`;
  const response = page({
    ctx,
    title: `${repo.name}`,
    description: appLine({
      private: repo.visibility === "private",
      name: repo.name,
      description: repo.description,
      state: envPhrase(
        envsFor(ctx.app, ctx.auth.user, record).find(
          (e) => e.env === "production",
        ),
      ).word,
    }),
    ogImage: appCardPath(repo, record),
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}\n${appTailJs}`,
  });
  notePhase(req, "render", performance.now() - rendering);
  return response;
}
