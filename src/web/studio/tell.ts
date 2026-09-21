/**
 * One tell in the studio: a tell is one sentence someone said, and the page
 * answers three questions — who has it, what it is waiting on, and what the
 * crew has done with it. Where it stands is `tellWord`, which every studio
 * list of tells reads too, so a tell says the same thing in a row as it does
 * on its own page. Nothing a dev-mode reader needs (labels, milestones, the
 * dependency form) belongs here; `?mode=dev` reads that page, unchanged.
 */

import type { Database } from "bun:sqlite";
import { appsRuntime } from "../../apps/runtime.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { dependenciesOf } from "../../core/dependencies.ts";
import { listEvents } from "../../core/events.ts";
import type { Issue } from "../../core/issues.ts";
import { getPull, openPullsClosing, type Pull } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
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
  card,
  icon,
  listCard,
  originTag,
  row,
  stateBadge,
  time,
  userLink,
} from "../ui.ts";
import { previewCard } from "../pages/apps.ts";
import { costText, durationText, reasonWords } from "../pages/runs.ts";
import { composer, conversation, originGlyph } from "../pages/thread.ts";
import { changeHref, tellHref } from "./nouns.ts";
import {
  pullWord,
  runWord,
  wordBadge,
  type Word,
  type WordCtx,
} from "./words.ts";

/** The pull whose merge closed this issue, from the event it left behind —
 * the same record `stateEvents` (thread.ts) reads for the timeline's own
 * "closed this" line, so this never disagrees with what the page already
 * shows. Undefined for an issue closed by hand, or still open. */
function shippedBy(db: Database, repo: Repo, issue: Issue): Pull | undefined {
  if (issue.state !== "closed") return undefined;
  const closed = listEvents(db, { repoId: repo.id, limit: 200 }).find(
    (e) =>
      e.kind === "issue.closed" &&
      Number(e.payload.number) === issue.number &&
      e.payload.by === "merge",
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
 * word, else *told*: said, and nobody has picked it up yet. Undefined for
 * a closed issue nothing merged shut, so the caller falls back to the
 * plain state badge dev uses.
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
  if (activeRunFor(db, "agent", issue.id) !== undefined)
    return { word: "working", note: "working now" };
  const last = listRuns(db, repo.id, {
    kind: "agent",
    issueId: issue.id,
    limit: 1,
  })[0];
  if (last !== undefined) return await runWord(wordCtx, last);
  return { word: "told", note: "not picked up yet" };
}

/** Every open issue this one waits for, and every one that waits for it —
 * read-only: the dependency form stays dev's alone (`dependenciesCard`,
 * thread.ts). */
function tellDependencies(base: string, issue: Issue, db: Ctx["app"]["db"]): Html {
  const { blockedBy, blocks } = dependenciesOf(db, issue.id);
  const list = (items: readonly Issue[]) =>
    html`<ul class="dep-list">
      ${items.map(
        (i) =>
          html`<li data-state="${i.state}">
            ${icon(i.state === "closed" ? "issueClosed" : "issue")}
            <a href="${tellHref(base, i.number)}">${i.title}</a>
            <span class="muted small">#${i.number}</span>
          </li>`,
      )}
    </ul>`;
  if (blockedBy.length === 0 && blocks.length === 0)
    return card(
      html`<p class="muted small">Waits for nothing, holds up nothing.</p>`,
      { head: html`${icon("map")} <h2>Depends on</h2>` },
    );
  return card(
    html`${blockedBy.length === 0
        ? html`<p class="muted small">Waits for nothing.</p>`
        : html`<p class="small">Waits for ${blockedBy.length}</p>
            ${list(blockedBy)}`}
      ${blocks.length === 0
        ? null
        : html`<p class="small mt">Holds up ${blocks.length}</p>
            ${list(blocks)}`}`,
    { head: html`${icon("map")} <h2>Depends on</h2>` },
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
 * preview — nothing here that `studioPull`/`previewCard` do not already
 * draw. */
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
 * GET /:owner/:name/issues/:number in studio mode: a tell is one sentence
 * someone said, and the page answers three questions — who has it, what it
 * is waiting on, and what the crew has done with it — nothing a dev-mode
 * reader needs (labels, milestones, the dependency form) belongs here.
 * `?mode=dev` reads that page, unchanged; the conversation and the reply
 * are the very same action as always (`conversation`/`composer`,
 * thread.ts).
 */
export async function studioTell(
  ctx: Ctx,
  repo: Repo,
  issue: Issue,
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  // Dev's own address for this tell, and the only one the page *posts* to:
  // the reply, the close and the escape to dev all live under
  // `/issues/:number`, whether a reader arrived there or at `/tells/:number`
  // (`tellHref`, nouns.ts). The write surface does not move with the noun.
  const thread = `${base}/issues/${issue.number}`;
  const direction = repo.directionIssueId === issue.id;
  const closingPull = openPullsClosing(db, repo.id).get(issue.number);
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record: getAppByRepo(db, repo.id),
  };
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
          ? html`${wordBadge(wordInfo.word)}
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
      <span
        >${issue.assigneeName === null
          ? html`<span class="muted">nobody has it yet</span>`
          : html`${when(issue.assigneeIsAgent, () => icon("bot"))}
              ${userLink(issue.assigneeName)} has it`}</span
      >
    </div>
  </div>`;

  const talk = conversation(ctx, repo, issue, { openVerb: "opened this" });

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
          stateAction: `${thread}/state`,
          state: issue.state,
          closeLabel: "Close tell",
        })}
      </div>
      <aside>
        ${runsCard}
        ${closingCard}
        ${tellDependencies(base, issue, db)}
      </aside>
    </div>
    <p class="muted small mt">
      <a href="${thread}?mode=dev">${icon("code")}Read the details</a> —
      labels, the dependency form and the assignee, dev's own way.
    </p>
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
    scriptJs: liveClientJs,
  });
}
