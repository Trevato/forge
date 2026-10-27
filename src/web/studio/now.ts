/**
 * Now — one row per thing going on in an app, in the five words: the open
 * changes, the crew's runs, and the tells nobody has picked up yet. It is
 * one live region on the app page (`#live-now`) with an address of its own
 * (`GET /:owner/:name/app/now`), so a live event fetches this card and
 * nothing else — and a card that did not change comes back as a 304, not
 * a repaint (`layout.fragment`, `client.liveRegionsJs`).
 */

import { eventRows, mayView, sealedScope } from "../../core/sealed.ts";
import { envPull } from "../../apps/data.ts";
import { appsRuntime, envsFor } from "../../apps/runtime.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { listCrewRoles } from "../../core/agents.ts";
import { getAppByRepo, type AppRecord } from "../../core/apps.ts";
import { getIssuesByIds, listIssues } from "../../core/issues.ts";
import { listPulls, openPullsClosing, type Pull } from "../../core/pulls.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { latestRunsForIssues, listRuns, type Run } from "../../core/runs.ts";
import { getUsersByIds } from "../../core/users.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { readRunLogTail } from "../../runs/log.ts";
import { mayReadRunLog } from "../../actions/runs.ts";
import { loadRepo, repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { fragment, missingFragment } from "../layout.ts";
import { avatar, badge, btn, card, icon, listCard, row, time } from "../ui.ts";
import { changeHref, tellHref } from "./nouns.ts";
import { LOG_TAIL_CAP, logBox } from "./log.ts";
import { appPanels } from "./previews.ts";
import { stopForm } from "./run.ts";
import { tellWords } from "./tell.ts";
import { voiceFor, type Actor } from "./voice.ts";
import {
  knowPulls,
  knowRunPulls,
  pullWord,
  runWord,
  servingHistory,
  wordBadge,
  type WordCtx,
} from "./words.ts";

/** The events that can change what Now says. */
export const NOW_LIVE = "run.queued,run.started,run.finished,pull.*,issue.*";

/**
 * The card in its live region: the kinds it listens for, the repository
 * they must be about, and its own address. The fragment answers with this
 * same element, so the client swaps like for like.
 */
export function nowRegion(repo: Repo, now: Html): Html {
  return html`<div
    id="live-now"
    data-live="${NOW_LIVE}"
    data-live-repo="${repo.ownerName}/${repo.name}"
    data-live-src="${repoBase(repo)}/app/now"
  >
    ${now}
  </div>`;
}

export async function nowCard(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
  o: {
    openPulls: readonly Pull[];
    /** How many builders the crew has: none, and an untaken tell is stuck. */
    builderCount: number;
    ownerFacts: boolean;
    wordCtx: WordCtx;
    /** Whether the head card is tailing production's own deploy. */
    deployTailing: boolean;
  },
): Promise<{ card: Html }> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const { openPulls, builderCount, ownerFacts, wordCtx, deployTailing } = o;
  // A run on a sealed report, and the report, are for who may see it.
  const recent = listRuns(db, repo.id, { kind: "agent", limit: 8 });
  const sealed = eventRows(
    db,
    recent.map((r) => ({ repoId: repo.id, payload: { issueId: r.issueId } })),
  );
  const runs = recent.filter((r) => {
    const row = r.issueId === null ? undefined : sealed.get(r.issueId);
    return row === undefined || mayView(db, repo, row, ctx.auth.user);
  });
  const actors = getUsersByIds(
    db,
    runs.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const issues = getIssuesByIds(
    db,
    runs.flatMap((r) => (r.issueId === null ? [] : [r.issueId])),
  );
  const proposed = new Set(openPulls.map((p) => p.id));
  const openByIssue = openPullsClosing(db, repo.id);
  const openTells = listIssues(db, repo.id, {
    kind: "issue",
    state: "open",
    limit: 30,
    ...sealedScope(db, repo, ctx.auth.user),
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
  // With nobody on the crew to build, `tell` cannot route a tell to
  // anyone — it stays unassigned forever, not merely unpicked-up like
  // `waiting` below. Scoped to that one honest cause (never to a tell a
  // person simply hasn't assigned while builders exist), so widening this
  // never turns "Now" into a plain issue list.
  const untaken =
    builderCount === 0
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
  // The words below ask per open change and per finished run; read them for
  // all the rows at once, so the card is a handful of queries, not one apiece.
  knowPulls(wordCtx, openPulls);
  knowRunPulls(wordCtx, rowsNow);
  // Who signs a "Now" row is the one rule for it, `voiceFor`
  // (`studio/voice.ts`): a person is named to anyone who can see the row —
  // the same name `/pulls` and the pull request's own page give — and only the
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
  const activeTail =
    activeRun && mayReadRunLog(ctx.app, ctx.auth.user, repo)
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
          ? html`${wordBadge(word)} ${stop}`
          : wordBadge(word),
      }),
    );
    if (activeTail !== undefined && r.id === activeRun?.id)
      runRows.push(html`<li class="card-body">${activeTail}</li>`);
  }

  // An environment the sleep sweep is sparing because it is mid-work:
  // that is something going on in the app, and the reason it is awake.
  const busyRows = envsFor(ctx.app, ctx.auth.user, record).flatMap((env) => {
    if (env.busy === undefined) return [];
    const number = envPull(env.env);
    return [
      row({
        href: `${base}#app-head`,
        nav: true,
        lead: icon(number === undefined ? "rocket" : "pull"),
        title: number === undefined ? "production" : `preview of #${number}`,
        meta: html`${env.busy}; kept awake past its idle window`,
        trail: badge("busy", { icon: "activity", tone: "attn" }),
      }),
    ];
  });

  const heldWords = await tellWords(wordCtx, repo, held, new Map());
  const heldRows = held.map((i, n) => {
    const { word, note } = heldWords[n] ?? { word: "told" as const, note: "held" };
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
  });

  const nowRows: Html[] = [
    ...busyRows,
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
        meta: html`${who} · opened ${time(i.createdAt)}, not picked up yet`,
        trail: wordBadge("waiting"),
      });
    }),
    // Held by a person: `tellWord` — the one place a tell's word is
    // decided (`studio/tell.ts`) — says so honestly, the same word and
    // note the issue's own page and the issues list already show for it.
    // `personHeld` has already established the holder is a person, so
    // `voiceFor` names them to every viewer who can see the row.
    ...heldRows,
    ...stuck.map((i) => {
      return row({
        lead: avatar("crew"),
        title: html`<a href="${tellHref(base, i.number)}">${i.title}</a>`,
        // The invitation is a writer's (the shelf's rule, `ownerFacts`); the
        // fact — nobody has taken it — stays for everyone.
        meta: html`opened ${time(i.createdAt)} ·
          <span class="muted">nobody on the crew to take it</span>${ownerFacts
            ? html` — <a href="${base}/settings">add someone</a>`
            : null}`,
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
  return { card: now };
}

// GET /:owner/:name/app/now — the card alone, for the region that shows it.
export async function appNowFragment(ctx: Ctx): Promise<Response> {
  const req = ctx.request;
  notePhase(req, "session", takeSessionTime(req));
  const repo = timePhase(req, "repo", () => loadRepo(ctx));
  const db = ctx.app.db;
  const record = repo && timePhase(req, "record", () => getAppByRepo(db, repo.id));
  if (!repo || !record) return missingFragment(req);
  const openPulls = timePhase(req, "pulls", () =>
    listPulls(db, repo.id, {
      state: "open",
      limit: 10,
      ...sealedScope(db, repo, ctx.auth.user),
    }),
  );
  const builderCount = timePhase(
    req,
    "crew",
    () => listCrewRoles(db, repo.id).filter((c) => c.role === "builder").length,
  );
  const ownerFacts = timePhase(req, "owner", () =>
    canSeeOwnerFacts(db, repo, ctx.auth.user),
  );
  // The one fact Now borrows from the head card, decided where the head
  // card decides it, so the two never disagree about what is tailing.
  const deployTailing = timePhase(
    req,
    "panels",
    () => appPanels(ctx, repo, record, openPulls).deployTailing,
  );
  const rendering = performance.now();
  const { card } = await nowCard(ctx, repo, record, {
    openPulls,
    builderCount,
    ownerFacts,
    wordCtx: {
      db,
      dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
      runtime: appsRuntime(ctx.app),
      record,
      history: servingHistory(),
      viewer: ctx.auth.user,
    },
    deployTailing,
  });
  const response = fragment(nowRegion(repo, card), { request: req });
  notePhase(req, "render", performance.now() - rendering);
  return response;
}
