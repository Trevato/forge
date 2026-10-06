/**
 * One tell in the studio: a tell is one sentence someone said, and the page
 * answers three questions — who has it, what it is waiting on, and what the
 * crew has done with it. Where it stands is `tellWord`, which every studio
 * list of tells reads too, so a tell says the same thing in a row as it does
 * on its own page. Nothing a dev-mode reader needs (labels, milestones, the
 * dependency form) belongs here; `?mode=dev` reads that page, unchanged.
 */

import { threadNote } from "../../crew/direct.ts";
import type { Database } from "bun:sqlite";
import { appsRuntime } from "../../apps/runtime.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { listEvents } from "../../core/events.ts";
import { repoGraph } from "../../core/dependencies.ts";
import { labelsFor, listLabels, type Issue } from "../../core/issues.ts";
import { getPull, openPullsClosing, type Pull } from "../../core/pulls.ts";
import { canEnterApp, canWrite, type Repo } from "../../core/repos.ts";
import { activeRunFor, listRuns } from "../../core/runs.ts";
import { getUsersByIds } from "../../core/users.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  avatar,
  badge,
  btn,
  card,
  icon,
  labelCss,
  listCard,
  originTag,
  row,
  stateBadge,
  time,
  userLink,
} from "../ui.ts";
import { previewCard } from "../pages/apps.ts";
import {
  costText,
  durationText,
  reasonWords,
  workSpent,
} from "../pages/runs.ts";
import {
  assigneeCard,
  composer,
  conversation,
  dependenciesCard,
  labelsCard,
  originGlyph,
  threadContext,
} from "../pages/thread.ts";
import { changeHref, tellHref } from "./nouns.ts";
import {
  pullWord,
  runWord,
  wordBadge,
  type Word,
  servingHistory,
  type WordCtx,
} from "./words.ts";

/** The pull whose merge closed this issue, from the event it left behind —
 * the same record `stateEvents` (thread.ts) reads for the timeline's own
 * "closed this" line, so this never disagrees with what the page already
 * shows. Undefined for an issue closed by hand, or still open. */
function shippedBy(db: Database, repo: Repo, issue: Issue): Pull | undefined {
  if (issue.state !== "closed") return undefined;
  const closed = listEvents(db, {
    repoId: repo.id,
    kind: "issue.closed",
    limit: 200,
  }).find(
    (e) => Number(e.payload.number) === issue.number && e.payload.by === "merge",
  );
  if (closed === undefined) return undefined;
  const number = Number(closed.payload.pull);
  return Number.isInteger(number) ? getPull(db, repo.id, number) : undefined;
}

/**
 * Where one tell stands, in the studio's own words: the pull that closed
 * or closes it — judged by `pullWord`, the one place that fact is decided,
 * so a merged tell reads *shipped* only once production is serving it,
 * same as everywhere else — else a run in flight, else its last run's own
 * word, else *told*: said, and nobody has picked it up yet — or, when a
 * person holds it rather than an agent, simply *held*: nothing is queued
 * for the crew, so it is never worded as if it were. Undefined for a
 * closed issue nothing merged shut, so the caller falls back to the plain
 * state badge dev uses.
 */
export async function tellWord(
  wordCtx: WordCtx,
  repo: Repo,
  issue: Issue,
  closingPull: Pull | undefined,
): Promise<{ word: Word; note: string } | undefined> {
  const db = wordCtx.db;
  if (issue.state === "closed") {
    const pull = shippedBy(db, repo, issue);
    return pull ? await pullWord(wordCtx, pull) : undefined;
  }
  if (closingPull !== undefined) return await pullWord(wordCtx, closingPull);
  // A private app's runs are for those who may enter it: anyone else reads
  // that it was told, never how the crew is getting on with it.
  if (!runsOpenTo(wordCtx, repo)) return { word: "told", note: "told" };
  if (activeRunFor(db, "agent", issue.id) !== undefined)
    return { word: "working", note: "working now" };
  // Deferred work is not waiting to be picked up: the crew will not take
  // it, and the page says why, as the map does.
  const deferred = deferredWhy(wordCtx, repo, issue);
  if (deferred !== undefined)
    return { word: "told", note: `deferred: ${deferred}` };
  const last = listRuns(db, repo.id, {
    kind: "agent",
    issueId: issue.id,
    limit: 1,
  })[0];
  if (last !== undefined) return await runWord(wordCtx, last);
  // A person can hold a tell the same as an agent can — the crew has never
  // touched it, but nobody is waiting on the crew to either, so it is
  // honest to say who has it rather than that it is unpicked, as if it
  // were still sitting in a queue.
  if (issue.assigneeId !== null && !issue.assigneeIsAgent)
    return { word: "told", note: "held" };
  return {
    word: "told",
    note:
      wordCtx.record === undefined ? "waiting for someone" : "not picked up yet",
  };
}

/** One graph read for each repository on a page, however many tells it words. */
const deferrals = new WeakMap<
  WordCtx,
  Map<string, ReadonlyMap<string, string>>
>();

/** Why this issue is deferred (`core/dependencies.ts`), when it is. */
function deferredWhy(
  wordCtx: WordCtx,
  repo: Repo,
  issue: Issue,
): string | undefined {
  let byRepo = deferrals.get(wordCtx);
  if (byRepo === undefined) deferrals.set(wordCtx, (byRepo = new Map()));
  let known = byRepo.get(repo.id);
  if (known === undefined)
    byRepo.set(repo.id, (known = repoGraph(wordCtx.db, repo.id).deferred));
  return known.get(issue.id);
}

/** Whether the reader may see this repository's runs (`mayReadRuns`). */
function runsOpenTo(wordCtx: WordCtx, repo: Repo): boolean {
  const record = wordCtx.record;
  return (
    record === undefined ||
    canEnterApp(wordCtx.db, repo, record, wordCtx.viewer, { named: false })
  );
}

/** Every agent run for this tell, newest first: who, how long, what it
 * cost, and its state in the studio's own word — the title opens the
 * transcript. Empty when the crew has not touched it yet. */
async function tellRuns(
  wordCtx: WordCtx,
  repo: Repo,
  issue: Issue,
): Promise<Html | null> {
  if (!runsOpenTo(wordCtx, repo)) return null;
  const runs = listRuns(wordCtx.db, repo.id, {
    kind: "agent",
    issueId: issue.id,
    limit: 10,
  });
  if (runs.length === 0) return null;
  const base = repoBase(repo);
  const actors = getUsersByIds(
    wordCtx.db,
    runs.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const rows = await Promise.all(
    runs.map(async (r) => {
      const who =
        r.actorId === null ? "crew" : (actors.get(r.actorId)?.username ?? "crew");
      const { word } = await runWord(wordCtx, r);
      const duration = durationText(r);
      return row({
        href: `${base}/runs/${r.id}`,
        nav: true,
        lead: avatar(who),
        title: html`${who} <span class="muted">${reasonWords(r.reason)}</span>`,
        meta: html`${duration ? html`${duration} · ` : null}${r.summary ||
        "no summary yet"}`,
        trail: html`${wordBadge(word)}${when(
          r.costUsd > 0,
          () =>
            html`<span class="num muted small">${costText(r.costUsd)}</span>`,
        )}`,
      });
    }),
  );
  return listCard(rows, {
    head: html`${icon("bot")}
      <h2>Runs</h2>`,
  });
}

/** The pull that closes this tell, with its check and a way into its
 * preview — nothing here that the change page or `previewCard` do not
 * already draw. */
async function tellClosingPull(
  ctx: Ctx,
  wordCtx: WordCtx,
  repo: Repo,
  pull: Pull,
): Promise<Html> {
  const base = repoBase(repo);
  const { word, note } = await pullWord(wordCtx, pull);
  return html`${card(
    html`<p>
      <a href="${changeHref(base, pull.number)}">${pull.title}</a>
      ${wordBadge(word)} <span class="muted small">${note}</span>
    </p>`,
    { head: html`${icon("pull")} <h2>Closes with</h2>` },
  )}${previewCard(ctx, repo, pull)}`;
}

/**
 * GET /:owner/:name/issues/:number and /tells/:number: one page, two
 * addresses, for every repository and every viewer — `?mode=dev` and the
 * mode cookie change nothing. Same `threadContext` at both, so a reader who
 * may not see it gets the forge's not-found at either.
 */
export async function tellPage(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  return await studioTell(ctx, found.repo, found.issue);
}

/**
 * A tell is one sentence someone said, and the page answers three
 * questions up front — who has it, what it is waiting on, and what the
 * crew has done with it. The rest a person sometimes changes — who has it,
 * its labels — sits in one quiet Details section,
 * closed until asked for; the conversation, the reply and the close (with
 * its reason) are the very same actions as always (`conversation`,
 * `composer`, thread.ts).
 */
async function studioTell(
  ctx: Ctx,
  repo: Repo,
  issue: Issue,
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  // The only address the page *posts* to: the reply, the close and every
  // Details form live under `/issues/:number`, whether a reader arrived
  // there or at `/tells/:number` (`tellHref`, nouns.ts). The write surface
  // does not move with the noun.
  const thread = `${base}/issues/${issue.number}`;
  const direction = repo.directionIssueId === issue.id;
  const closingPull = openPullsClosing(db, repo.id).get(issue.number);
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record: getAppByRepo(db, repo.id),
    history: servingHistory(),
    viewer: ctx.auth.user,
  };
  // A repository that is not an app speaks of issues, not tells.
  const plain = wordCtx.record === undefined;
  // Closing is the author's or a writer's (`setIssueState`); nobody else is
  // shown a button the server would only refuse.
  const user = ctx.auth.user;
  const mayClose =
    user !== undefined &&
    (user.id === issue.authorId || canWrite(db, repo, user));
  const [wordInfo, runsCard, closingCard] = await Promise.all([
    direction ? undefined : tellWord(wordCtx, repo, issue, closingPull),
    tellRuns(wordCtx, repo, issue),
    closingPull ? tellClosingPull(ctx, wordCtx, repo, closingPull) : undefined,
  ]);

  const head = html`<div class="issue-head">
    <h1>${issue.title} <span class="number">#${issue.number}</span></h1>
    <div class="issue-meta">
      ${direction
        ? html`<span class="muted small"
            >${icon("map")} the repository's standing direction — always
            open, read by the planner directly, never picked up like an
            ordinary tell</span
          >`
        : wordInfo
          ? html`${wordBadge(wordInfo.word, undefined, plain)}
              <span class="muted small">${wordInfo.note}</span>`
          : stateBadge(issue.state)}
      <span
        >${issue.originAuthor
          ? originTag(issue.originAuthor, originGlyph(repo))
          : userLink(issue.authorName)}
        opened this ${time(issue.createdAt)}</span
      >
      ${when(
        issue.originUrl,
        (url) =>
          html`<a class="origin-link" href="${url}" rel="noreferrer noopener"
            >${icon("external")}view on origin</a
          >`,
      )}
      ${when(
        issue.sealed,
        () =>
          badge("Sealed security report", { tone: "danger", icon: "lock" }),
      )}
      ${workSpent(ctx, repo, issue.id)}
      ${issue.assigneeName !== null
        ? html`<span
            >${when(issue.assigneeIsAgent, () => icon("bot"))}
            ${userLink(issue.assigneeName)} has it</span
          >`
        : !direction && wordInfo?.word === "told"
          ? html`<span class="muted">nobody has it yet</span>`
          : null}
    </div>
  </div>`;

  const talk = conversation(ctx, repo, issue, { openVerb: "opened this" });
  const applied = labelsFor(db, issue.id);
  const allLabels = listLabels(db, repo.id);
  // Closed until asked for: neither is the next thing a person does here,
  // and both are one tap away when it is. What it waits for stays in view
  // above them — one of the three questions the page answers — with its
  // form for whoever may change it.
  const details = html`<details class="quiet-details mt">
    <summary>Details</summary>
    ${assigneeCard(ctx, repo, issue, `${thread}/assignee`)}
    ${labelsCard(ctx, repo, issue, applied, allLabels, `${thread}/labels`)}
    ${sealCard(ctx, repo, issue, `${thread}/seal`)}
  </details>`;

  const body = html`${repoHeader(ctx, repo, "issues", {
      compact: true,
      ownTitle: true,
    })}
    ${head}
    <div class="split">
      <div>
        ${talk.node}
        ${composer(ctx, {
          action: `${thread}/comments`,
          ...(mayClose ? { stateAction: `${thread}/state` } : {}),
          state: issue.state,
          closeLabel: plain ? "Close issue" : "Close tell",
          crewNote: threadNote(ctx.app.db, repo, issue),
          reasons: true,
        })}
      </div>
      <aside>
        ${runsCard}
        ${closingCard}
        ${dependenciesCard(ctx, repo, issue, `${thread}/dependencies`)}
        ${details}
      </aside>
    </div>
    ${liveMount({
      repo: base,
      thread: "issue",
      number: issue.number,
      lastCommentId: talk.lastCommentId,
    })}`;

  return page({
    ctx,
    title: `${issue.title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: labelCss([...allLabels, ...applied]),
    scriptJs: liveClientJs,
  });
}

/**
 * Seal or unseal, for someone who can write here (`core/sealed.ts`).
 * Unsealing publishes the report and its fix, so it says so on the button.
 */
function sealCard(ctx: Ctx, repo: Repo, issue: Issue, action: string): Html | null {
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return null;
  return html`<form method="post" action="${action}" class="mt">
    <input type="hidden" name="sealed" value="${issue.sealed ? "0" : "1"}" />
    ${btn(
      issue.sealed
        ? "Unseal: publish this report, its fix and their whole history to every reader"
        : "Seal as a security report",
      { variant: issue.sealed ? "danger" : "ghost", icon: "lock" },
    )}
  </form>`;
}
