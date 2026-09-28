/**
 * The app in the studio: one page per app, and the front door a person acts
 * from — the box they tell the crew in, what asks them, and Now, one row per
 * thing the crew has in hand in the studio's own words. Money, the crew
 * roster, autonomy and the decision ledger are the owner's facts and render
 * only for a viewer who can write here; a stranger sees the app.
 */

import { appsRuntime } from "../../apps/runtime.ts";
import { listCrewRoles } from "../../core/agents.ts";
import type { AppRecord } from "../../core/apps.ts";
import { decisionStats, type DecisionStat } from "../../core/decisions.ts";
import { getIssueById, listIssues, type Issue } from "../../core/issues.ts";
import {
  listPulls,
  mergedPullCount,
  openPullsClosing,
} from "../../core/pulls.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import {
  agentRunTotals,
  latestRunsForIssues,
  listRuns,
  previewLatency,
  type PreviewLatency,
  type Run,
} from "../../core/runs.ts";
import { getUsersByIds } from "../../core/users.ts";
import { autonomyStatus } from "../../crew/autonomy.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { readRunLogTail } from "../../runs/log.ts";
import { crumbsFor, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { appTailJs, liveRegionsJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  avatar,
  btn,
  card,
  icon,
  listCard,
  row,
  time,
  userTag,
} from "../ui.ts";
import { changeHref, changesHref, tellHref, tellsHref } from "./nouns.ts";
import { LOG_TAIL_CAP, logBox } from "./log.ts";
import { appPanels } from "./previews.ts";
import { stopForm } from "./run.ts";
import { tellWord } from "./tell.ts";
import { voiceFor, type Actor } from "./voice.ts";
import {
  pullWord,
  runWord,
  servingHistory,
  wordBadge,
  type WordCtx,
} from "./words.ts";

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

/** The start of history, for an "ever" count rather than one week of it. */
const EPOCH = new Date(0).toISOString();

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
      : html`${latency.queueMedianSeconds.toFixed(1)}s waiting,
        ${latency.bootMedianSeconds.toFixed(1)}s coming
        up${latency.splitN < latency.n
          ? ` (${latency.splitN} of ${latency.n})`
          : ""}
        · `;
  return html`reaches its preview in ${latency.medianSeconds.toFixed(1)}s
    <span class="muted">· ${split}${latency.n} deploys${failedSuffix}</span>`;
}

export async function studioApp(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  // Money, the crew roster, autonomy limits and the decision ledger are the
  // owner's facts, not the app's — a viewer who cannot write here reads this
  // page as a stranger, whatever else they can see of the repository.
  const ownerFacts = canSeeOwnerFacts(db, repo, ctx.auth.user);
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record,
    history: servingHistory(),
  };
  const crew = listCrewRoles(db, repo.id);
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent);
  const runs = listRuns(db, repo.id, { kind: "agent", limit: 8 });
  const actors = getUsersByIds(
    db,
    runs.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const issues = new Map<string, Issue>();
  for (const r of runs)
    if (r.issueId !== null && !issues.has(r.issueId)) {
      const i = getIssueById(db, r.issueId);
      if (i) issues.set(r.issueId, i);
    }
  const openPulls = listPulls(db, repo.id, { state: "open", limit: 10 });
  const week = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  // What landed this week, counted by the database like the runs and the
  // spend below — a page of closed pulls would stop at a hundred and the
  // cost per shipped change would read high off the short count.
  const shipped = mergedPullCount(db, repo.id, week);
  // The rest is spend, worked out only for a viewer who is going to see it —
  // counted by the database over the whole week, not off a page of rows.
  const weekTotals = ownerFacts
    ? agentRunTotals(db, repo.id, week)
    : { runs: 0, spentUsd: 0 };
  const spent = weekTotals.spentUsd;
  const ledgerWeek = ownerFacts ? decisionStats(db, repo.id, week) : [];
  const weekLatency = ownerFacts
    ? previewLatency(db, repo.id, week)
    : undefined;
  // Whether there is any history at all — ever, not this week's — so a
  // fresh app reads as "nothing yet" rather than a stretch of zeros and a
  // scary ratio (#274). A quiet week on an old app still has shipped a
  // change or taken a run at some point; only an app with neither, ever,
  // gets the quieter line. Deploys are not part of this: they happen on
  // their own the moment an app exists, so they say nothing about whether
  // anyone has done anything yet.
  const everShipped = shipped > 0 || mergedPullCount(db, repo.id, EPOCH) > 0;
  const everRuns = ownerFacts
    ? weekTotals.runs > 0 || agentRunTotals(db, repo.id, EPOCH).runs > 0
    : false;
  const hasHistory = everShipped || everRuns;
  const autonomy =
    !ownerFacts || repo.autonomy === "off"
      ? undefined
      : autonomyStatus(ctx.app, repo);

  // ---- the app itself ----
  // `deployTailing` says the head card is tailing production's own deploy,
  // narrowly — just the "Now" panel's empty-state words below care about
  // that distinction. `tailing` says the head card carries any live tail at
  // all, deploy or a running app's own output (`studio/previews.ts`'s
  // `productionTail`, #284) — the no-script refresh below must keep the
  // page moving for either, not only for an agent run's tail beside a "Now"
  // row.
  const { head, previews, deployTailing, tailing } = appPanels(
    ctx,
    repo,
    record,
    openPulls,
  );

  // ---- the box ----
  // Telling the crew, and who takes it, is the owner's own front door — a
  // stranger sees the app, not who is behind it.
  const tell = !ownerFacts
    ? null
    : html`<form
        class="card comment-form studio-tell"
        method="post"
        action="${base}/tell"
      >
        <label class="sr-only" for="tell">Tell the crew</label>
        <textarea
          class="input"
          id="tell"
          name="text"
          rows="3"
          required
          placeholder="${builders.length === 0
            ? "Add a crew member under Settings → Crew, then tell them what you want."
            : "What should change? One thing at a time works best."}"
        ></textarea>
        <div class="bar">
          <span class="muted small">
            ${builders.length === 0
              ? html`Nobody on the crew yet.`
              : html`${builders
                  .map((b) => userTag(b.user.username))
                  .reduce((a, b) => html`${a} ${b}`)}
                ${builders.length === 1 ? "takes it" : "share the work"}`}
          </span>
          <span class="spacer"></span>
          ${btn("Tell the crew", { variant: "primary", type: "submit" })}
        </div>
      </form>`;

  // ---- now: one row per thing, in the five words ----
  const proposed = new Set(openPulls.map((p) => p.id));
  const openByIssue = openPullsClosing(db, repo.id);
  const openTells = listIssues(db, repo.id, {
    kind: "issue",
    state: "open",
    limit: 30,
  });
  const told = openTells.filter(
    (i) => i.assigneeIsAgent && !openByIssue.has(i.number),
  );
  // A person can hold a tell exactly as an agent can — #224's own rule for
  // a change applies here too: the front door counts work by what it is,
  // not by who is doing it. Scoped to `assigneeId`, never widened to every
  // open tell, so an ordinary unassigned backlog still stays off this
  // panel.
  const personHeld = openTells.filter(
    (i) =>
      i.assigneeId !== null &&
      !i.assigneeIsAgent &&
      i.id !== repo.directionIssueId &&
      !openByIssue.has(i.number),
  );
  // With nobody on the crew to build, `tellCrew` cannot route a tell to
  // anyone — it stays unassigned forever, not merely unpicked-up like
  // `waiting` below. Scoped to that one honest cause (never to a tell a
  // person simply hasn't assigned while builders exist), so widening this
  // never turns "Now" into a plain issue list.
  const untaken =
    builders.length === 0
      ? openTells
          .filter(
            (i) =>
              i.assigneeId === null &&
              i.id !== repo.directionIssueId &&
              !openByIssue.has(i.number),
          )
          .slice(0, 5)
      : [];
  const everRan = latestRunsForIssues(
    db,
    [...told, ...personHeld, ...untaken].map((i) => i.id),
    ["agent"],
  );
  const waiting = told.filter((i) => !everRan.has(i.id)).slice(0, 5);
  const held = personHeld.filter((i) => !everRan.has(i.id)).slice(0, 5);
  const stuck = untaken.filter((i) => !everRan.has(i.id));
  const issueNumberById = new Map(
    [...told, ...personHeld, ...untaken].map((i) => [i.id, i.number]),
  );
  const rowsNow = runs
    .filter((r) => {
      if (r.issueId === null) return true;
      if (proposed.has(r.issueId)) return false;
      const n = issueNumberById.get(r.issueId) ?? issues.get(r.issueId)?.number;
      return n === undefined || !openByIssue.has(n);
    })
    .filter(
      (r, idx, all) => all.findIndex((x) => x.issueId === r.issueId) === idx,
    )
    .slice(0, 6);
  // Who signs a "Now" row is the one rule for it, `voiceFor`
  // (`studio/voice.ts`): a person is named to anyone who can see the row —
  // the same name `/changes` and the change's own page give — and only the
  // crew's own work reads as the app's own story for a viewer who cannot
  // see the roster. The avatar takes the same string, so its initials can
  // never disagree with the name beside them.
  const runActor = (r: Run): Actor => ({
    name: r.actorId === null ? undefined : actors.get(r.actorId)?.username,
    // A run with nobody on it is the crew's own, never a person's.
    isAgent: r.actorId === null || actors.get(r.actorId)?.kind === "agent",
  });

  // The one run actually going, if any: its row gets a tail of its own
  // log — the last handful of lines, streamed live — beside it. Only one,
  // so the page never opens a stream per row.
  const activeRun = rowsNow.find(
    (r) => r.kind === "agent" && r.state === "running",
  );
  const activeTail = activeRun
    ? logBox({
        id: "app-run-tail",
        who: voiceFor(runActor(activeRun), ownerFacts),
        cap: LOG_TAIL_CAP,
        lines: readRunLogTail(
          ctx.app.config.dataDir,
          activeRun.id,
          LOG_TAIL_CAP,
        ).lines,
        stream: `/api/v1/repos/${repo.ownerName}/${repo.name}/runs/${activeRun.id}/log?follow=1`,
        className: "log-tail",
      })
    : undefined;

  const runRows: Html[] = [];
  for (const r of rowsNow) {
    const { word, note } = await runWord(wordCtx, r);
    const who = voiceFor(runActor(r), ownerFacts);
    const about = r.issueId === null ? undefined : issues.get(r.issueId);
    const stop = stopForm(ctx, repo, r);
    runRows.push(
      row({
        ...(stop ? {} : { href: `${base}/runs/${r.id}`, nav: true }),
        lead: avatar(who),
        title: stop
          ? html`<a href="${base}/runs/${r.id}">${about?.title ?? note}</a>`
          : (about?.title ?? note),
        meta: html`${who} · ${word === "working" ? "working now" : note}
        ${word === "working"
          ? null
          : html` · ${time(r.finishedAt ?? r.createdAt)}`}`,
        trail: stop
          ? html`<span class="studio-ask-actions"
              >${wordBadge(word)} ${stop}</span
            >`
          : wordBadge(word),
      }),
    );
    if (activeTail !== undefined && r.id === activeRun?.id)
      runRows.push(html`<li class="log-tail-row">${activeTail}</li>`);
  }

  const nowRows: Html[] = [
    ...(await Promise.all(
      openPulls.map(async (p) => {
        const { word, note } = await pullWord(wordCtx, p);
        const who = voiceFor(
          { name: p.authorName, isAgent: p.authorIsAgent },
          ownerFacts,
        );
        return row({
          href: changeHref(base, p.number),
          nav: true,
          lead: avatar(who),
          title: p.title,
          meta: html`${who} · ${note} · ${time(p.createdAt)}`,
          trail: wordBadge(word),
        });
      }),
    )),
    ...runRows,
    ...waiting.map((i) => {
      const who = voiceFor(
        { name: i.assigneeName ?? undefined, isAgent: i.assigneeIsAgent },
        ownerFacts,
      );
      return row({
        href: tellHref(base, i.number),
        nav: true,
        lead: avatar(who),
        title: i.title,
        meta: html`${who} · told ${time(i.createdAt)}, not picked up yet`,
        trail: wordBadge("waiting"),
      });
    }),
    // Held by a person: `tellWord` — the one place a tell's word is
    // decided (`studio/tell.ts`) — says so honestly, the same word and
    // note the tell's own page and "Everything told" already show for it.
    // `personHeld` has already established the holder is a person, so
    // `voiceFor` names them to every viewer who can see the row.
    ...(await Promise.all(
      held.map(async (i) => {
        const { word, note } = (await tellWord(
          wordCtx,
          repo,
          i,
          undefined,
        )) ?? {
          word: "told" as const,
          note: "held",
        };
        const who = voiceFor(
          { name: i.assigneeName ?? undefined, isAgent: false },
          ownerFacts,
          "someone",
        );
        return row({
          href: tellHref(base, i.number),
          nav: true,
          lead: avatar(who),
          title: i.title,
          meta: html`${who} · ${note} · ${time(i.createdAt)}`,
          trail: wordBadge(word),
        });
      }),
    )),
    ...stuck.map((i) => {
      return row({
        lead: avatar("crew"),
        title: html`<a href="${tellHref(base, i.number)}">${i.title}</a>`,
        meta: html`told ${time(i.createdAt)} ·
          <span class="muted">nobody on the crew to take it —</span>
          <a href="${base}/settings">add someone</a>`,
        trail: wordBadge("told"),
      });
    }),
  ];
  const now =
    nowRows.length === 0
      ? card(
          html`<p class="muted small">
            ${deployTailing
              ? "Production is coming up — the log above has it."
              : "Nothing yet. Tell the crew something."}
          </p>`,
          {
            head: html`${icon("activity")}
              <h2>Now</h2>`,
          },
        )
      : listCard(nowRows, {
          head: html`${icon("activity")}
            <h2>Now</h2>
            <span class="spacer"></span>
            ${btn("Every run", { href: `${base}/runs`, size: "sm" })}`,
        });

  // ---- the rail ----
  // Crew, spend and autonomy are the owner's facts; a viewer who cannot
  // write here gets only the shipped count, never the roster, the money or
  // the ledger — and the page never asks for the rest on their behalf.
  const crewCard = !ownerFacts
    ? null
    : crew.length === 0
      ? card(
          html`<p class="muted small">
            Nobody yet. <a href="${base}/settings">Add someone.</a>
          </p>`,
          {
            head: html`${icon("bot")}
              <h2>Crew</h2>`,
          },
        )
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
  const weekCard = card(
    !hasHistory
      ? html`<p class="muted small">
          Nothing to show yet — it fills in once a change
          ships${ownerFacts ? " or the crew takes a run" : ""}.
        </p>`
      : !ownerFacts
        ? html`<dl>
            <dt>Shipped</dt>
            <dd>${shipped} change${shipped === 1 ? "" : "s"}</dd>
          </dl>`
        : html`<dl>
            <dt>Shipped</dt>
            <dd>${shipped} change${shipped === 1 ? "" : "s"}</dd>
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
                    >· $${(spent / shipped).toFixed(2)} per shipped change</span
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
              ${autonomy.paused
                ? html`<dt>Paused</dt>
                    <dd>
                      ${autonomy.paused === "ceiling"
                        ? "at the ceiling, until 00:00 UTC"
                        : autonomy.paused}
                    </dd>`
                : null}
            </dl>`,
        {
          head: html`${icon("play")}
            <h2>On its own</h2>
            <span class="spacer"></span>
            ${btn("Change", { href: `${base}/settings`, size: "sm" })}`,
          extra: "about",
        },
      );
  const more = html`<p class="muted small">
    <a href="${base}/map">The map</a> ·
    <a href="${tellsHref(base)}">Everything told</a> ·
    <a href="${changesHref(base)}">Every change</a>
  </p>`;

  const body = html`${repoHeader(ctx, repo, "code", {
      compact: true,
      ownTitle: true,
    })}
    <div id="app-head">${head}</div>
    <div class="dash">
      <div class="dash-main stack">
        ${tell}
        <div id="app-previews">${previews}</div>
        <div
          id="live-now"
          data-live="run.*,pull.*,issue.*"
          data-live-repo="${repo.ownerName}/${repo.name}"
        >
          ${now}
        </div>
      </div>
      <aside class="dash-rail stack">
        ${crewCard} ${weekCard} ${ownCard} ${more}
      </aside>
    </div>
    ${liveMount({ repo: base, app: true })}`;
  return page({
    ctx,
    title: `${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}\n${appTailJs}`,
    // The no-script half of the tail: while the crew's run goes, the page
    // refreshes itself, the way the run's own page does; the script above
    // removes this the moment it can stream lines instead.
    ...(activeRun || tailing ? { refresh: { seconds: 5 } } : {}),
  });
}
