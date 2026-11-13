import type { Database } from "bun:sqlite";
/**
 * One tell in the studio: a tell is one sentence someone said, and the page
 * answers three questions — who has it, what it is waiting on, and what the
 * crew has done with it. Where it stands is `tellWord`, which every studio
 * list of tells reads too, so a tell says the same thing in a row as it does
 * on its own page. What it waits for (its dependencies) stays in view;
 * what a person only sometimes changes (who has it, its labels) waits in
 * one closed Details section.
 */

import { costRows, issueCostFor, type IssueCost } from "../../core/issue_cost.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { cardPath } from "../og/path.ts";
import { mayEditIssue } from "../../actions/issues.ts";
import { marksByName } from "../../core/marks.ts";
import { threadNote } from "../../crew/direct.ts";
import { alreadyDone } from "../../core/done_on_main.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { LATER_TITLED } from "../../core/pillars.ts";
import { deferredOf, linkedIssueIds } from "../../core/dependencies.ts";
import { hasPicture } from "../../core/note_pictures.ts";
import { heldBanner } from "../pages/gate.ts";
import {
  getIssuesByNumbers,
  labelsFor,
  listLabels,
  numberKey,
  type Issue,
} from "../../core/issues.ts";
import {
  getPull,
  joinMany,
  openPullsClosing,
  type Pull,
} from "../../core/pulls.ts";
import { canEnterApp, canWrite, getSealedFork, type Repo } from "../../core/repos.ts";
import { FLOW_LABEL } from "../../core/flow_label.ts";
import { flowButton } from "../flow_button.ts";
import { canSeeSealed } from "../../core/sealed.ts";
import {
  activeRunFor,
  activeRunsFor,
  latestRunsOfKind,
  listRuns,
  type Run,
} from "../../core/runs.ts";
import { getUsersByIds } from "../../core/users.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { currentOf, estimatesOf } from "../../core/estimates.ts";
import { estimateLine } from "../../flow/estimate_words.ts";
import { noteLine } from "./note.ts";
import { threadLine } from "../describe.ts";
import { page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  avatar,
  badge,
  btn,
  card,
  disclosure,
  icon,
  labelCss,
  listCard,
  originTag,
  row,
  stateBadge,
  time,
  userLink,
} from "../ui.ts";
import { previewBlock } from "../pages/apps.ts";
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
  issueTeamsCard,
  originGlyph,
  threadContext,
} from "../pages/thread.ts";
import { changeHref } from "./nouns.ts";
import {
  knowPulls,
  knowRunPulls,
  pullWord,
  runWord,
  wordBadge,
  type Word,
  servingHistory,
  type WordCtx,
} from "./words.ts";

/** Per word context, per repository: the pull each issue's merge closed. */
const mergeClosings = new WeakMap<
  WordCtx,
  Map<string, Map<number, number | null>>
>();

/**
 * Read, once for the numbers given, which pull's merge closed each of those
 * issues (the newest `issue.closed` event by merge wins), so wording a page
 * of tells costs one read, not one per row. `tellWord` falls back to a read
 * of its own number for a caller that did not say its page first.
 */
export function knowMergeClosings(
  wordCtx: WordCtx,
  repoId: string,
  numbers: readonly number[],
): void {
  const byRepo = mergeClosings.get(wordCtx) ?? new Map();
  mergeClosings.set(wordCtx, byRepo);
  const known: Map<number, number | null> = byRepo.get(repoId) ?? new Map();
  byRepo.set(repoId, known);
  const want = numbers.filter((n) => !known.has(n));
  if (want.length === 0) return;
  for (const n of want) known.set(n, null);
  const rows = wordCtx.db
    .query<{ number: unknown; pull: unknown }, [string, string]>(
      `SELECT json_extract(payload, '$.number') AS number,
              json_extract(payload, '$.pull') AS pull
         FROM event INDEXED BY event_kind
        WHERE repo_id = ?1 AND kind = 'issue.closed'
          AND json_extract(payload, '$.by') = 'merge'
          AND json_extract(payload, '$.number') IN (SELECT value FROM json_each(?2))
        ORDER BY seq`,
    )
    .all(repoId, JSON.stringify(want));
  // Oldest first, so the newest event for a number is the one left standing.
  for (const r of rows) known.set(Number(r.number), Number(r.pull));
}

/** The pull whose merge closed this issue, from the event it left behind —
 * the same record `stateEvents` (thread.ts) reads for the timeline's own
 * "closed this" line, so this never disagrees with what the page already
 * shows. Undefined for an issue closed by hand, or still open. */
function shippedBy(wordCtx: WordCtx, repo: Repo, issue: Issue): Pull | undefined {
  if (issue.state !== "closed") return undefined;
  knowMergeClosings(wordCtx, repo.id, [issue.number]);
  const number = mergeClosings.get(wordCtx)?.get(repo.id)?.get(issue.number);
  const read = told.get(wordCtx)?.shipped;
  if (number !== null && number !== undefined && read?.has(number))
    return read.get(number);
  return number !== null && number !== undefined && Number.isInteger(number)
    ? getPull(wordCtx.db, repo.id, number)
    : undefined;
}

/** What `tellWords` read ahead for a page, so `tellWord` reads nothing per row. */
// Scoped to one `tellWords` call: set before the words are read, deleted after,
// and keyed by the request's own `WordCtx`.
const told = new WeakMap<
  WordCtx,
  {
    active: Map<string, Run | undefined>;
    last: Map<string, Run | undefined>;
    shipped: Map<number, Pull | undefined>;
    /** The page's issues that sit on a dependency edge; the rest are never deferred. */
    linked: Set<string>;
    /** The ids the batch covered: only these may skip the graph. */
    covered: Set<string>;
  }
>();

/**
 * `tellWord` for a page of tells: the runs, pulls and checks of all of them
 * are read together first, so the page costs a handful of queries rather
 * than a few per row. Each word is the one `tellWord` gives (undefined for
 * a closed tell nothing merged shut), in the order of `issues`.
 */
export async function tellWords(
  wordCtx: WordCtx,
  repo: Repo,
  issues: readonly Issue[],
  closingPulls: ReadonlyMap<number, Pull>,
): Promise<({ word: Word; note: string } | undefined)[]> {
  const db = wordCtx.db;
  const read = {
    active: new Map<string, Run | undefined>(),
    last: new Map<string, Run | undefined>(),
    shipped: new Map<number, Pull | undefined>(),
    linked: linkedIssueIds(db, issues.map((i) => i.id)),
    covered: new Set(issues.map((i) => i.id)),
  };
  const pulls: Pull[] = [];
  const closed = issues.filter((i) => i.state === "closed");
  knowMergeClosings(wordCtx, repo.id, closed.map((i) => i.number));
  const closings = mergeClosings.get(wordCtx)?.get(repo.id);
  const numbers = closed.flatMap((i) => {
    const n = closings?.get(i.number);
    return n !== null && n !== undefined && Number.isInteger(n) ? [n] : [];
  });
  const found = getIssuesByNumbers(
    db,
    numbers.map((number) => ({ repoId: repo.id, number })),
  );
  for (const pull of joinMany(
    db,
    numbers.flatMap((n) => found.get(numberKey(repo.id, n)) ?? []),
  )) {
    read.shipped.set(pull.number, pull);
    pulls.push(pull);
  }
  for (const n of numbers) if (!read.shipped.has(n)) read.shipped.set(n, undefined);
  const lone = issues.filter(
    (i) => i.state !== "closed" && !closingPulls.has(i.number),
  );
  for (const issue of issues)
    if (issue.state !== "closed") {
      const pull = closingPulls.get(issue.number);
      if (pull !== undefined) pulls.push(pull);
    }
  if (runsOpenTo(wordCtx, repo)) {
    const ids = lone.map((i) => i.id);
    const active = activeRunsFor(db, "agent", ids);
    const last = latestRunsOfKind(db, "agent", ids);
    for (const id of ids) {
      read.active.set(id, active.get(id));
      read.last.set(id, last.get(id));
    }
    knowRunPulls(wordCtx, [...last.values()]);
  }
  knowPulls(wordCtx, pulls);
  told.set(wordCtx, read);
  try {
    return await Promise.all(
      issues.map((issue) => tellWord(wordCtx, repo, issue, closingPulls.get(issue.number))),
    );
  } finally {
    told.delete(wordCtx);
  }
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
    const pull = shippedBy(wordCtx, repo, issue);
    return pull ? await pullWord(wordCtx, pull) : undefined;
  }
  if (closingPull !== undefined) return await pullWord(wordCtx, closingPull);
  // A private app's runs are for those who may enter it: anyone else reads
  // that it was told, never how the crew is getting on with it.
  if (!runsOpenTo(wordCtx, repo)) return { word: "told", note: "told" };
  const read = told.get(wordCtx);
  const active = read?.active.has(issue.id)
    ? read.active.get(issue.id)
    : activeRunFor(db, "agent", issue.id);
  if (active !== undefined)
    return { word: "working", note: "working now" };
  // Deferred work is not waiting to be picked up: the crew will not take
  // it, and the page says why, as the map does.
  const deferred =
    read?.covered.has(issue.id) === true && !read.linked.has(issue.id) && !LATER_TITLED.test(issue.title)
      ? undefined
      : deferredWhy(wordCtx, repo, issue);
  if (deferred !== undefined)
    return { word: "told", note: `deferred: ${deferred}` };
  const last = read?.last.has(issue.id)
    ? read.last.get(issue.id)
    : listRuns(db, repo.id, { kind: "agent", issueId: issue.id, limit: 1 })[0];
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
    byRepo.set(repo.id, (known = deferredOf(wordCtx.db, repo)));
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
  const cost = issueCostFor(wordCtx.db, repo, issue, wordCtx.viewer);
  if (runs.length === 0 && cost === null) return null;
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
        meta: html`${duration ? html`${duration} · ` : null}${noteLine(r.summary || "no summary yet")}`,
        trail: html`${wordBadge(word)}${when(
          r.costUsd > 0,
          () =>
            html`<span class="num muted small">${costText(r.costUsd)}</span>`,
        )}`,
      });
    }),
  );
  return html`${runs.length === 0
    ? null
    : listCard(rows, {
        head: html`${icon("bot")}
          <h2>Runs</h2>`,
      })}${costBlock(cost, base)}`;
}

/** What the issue and its closing pulls cost, as `dl` rows; nothing when there is no cost to show. */
function costBlock(cost: IssueCost | null, base: string): Html | null {
  if (cost === null) return null;
  return html`<dl class="status-rows" data-issue-cost>${costRows(cost).map(
    (r) => html`<div class="status-row"><dt>${r.label}</dt><dd class="num">${
      r.pull === undefined ? null : html`<a href="${base}/pulls/${r.pull}">#${r.pull}</a> `
    }${costText(r.usd)}</dd></div>`,
  )}</dl>`;
}

/** The pull that closes this tell, with its check and a way into its
 * preview — nothing here that the change page or `previewBlock` do not
 * already draw. */
async function tellClosingPull(
  ctx: Ctx,
  wordCtx: WordCtx,
  repo: Repo,
  pull: Pull,
): Promise<Html> {
  const base = repoBase(repo);
  const { word, note } = await pullWord(wordCtx, pull);
  return html`${listCard(
    [row({ href: changeHref(base, pull.number), title: pull.title, meta: html`${note}`, trail: wordBadge(word) })],
    { head: html`${icon("pull")} <h2>Closes with</h2>` },
  )}${previewBlock(ctx, repo, pull)}`;
}

/**
 * GET /:owner/:name/issues/:number, for every repository and every viewer. Same `threadContext` at both, so a reader who
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
  const { request } = ctx;
  const started = performance.now();
  notePhase(request, "session", takeSessionTime(request));
  let linksMs = 0;
  const links = <T>(work: () => T): T => {
    const t = performance.now();
    try {
      return work();
    } finally {
      linksMs += performance.now() - t;
    }
  };
  const base = repoBase(repo);
  // The only address the page *posts* to: the reply, the close and every
  // Details form live under `/issues/:number`.
  const thread = `${base}/issues/${issue.number}`;
  const direction = repo.directionIssueId === issue.id;
  const closingPull = links(() => openPullsClosing(db, repo.id).get(issue.number));
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record: getAppByRepo(db, repo.id),
    history: servingHistory(),
    viewer: ctx.auth.user,
  };
  // Closing is the author's or a writer's (`setIssueState`); nobody else is
  // shown a button the server would only refuse.
  const user = ctx.auth.user;
  const mayClose =
    user !== undefined &&
    (user.id === issue.authorId || canWrite(db, repo, user));
  // The crew found it done on the base: one line, with the commits and the
  // button that closes it. The person closes; nothing here does.
  const doneBy = issue.state === "open" ? (alreadyDone(db, [issue.id]).get(issue.id) ?? []) : [];
  const doneLine =
    doneBy.length === 0
      ? null
      : card(
          html`<form method="post" action="${thread}/state" class="row" data-now="Closed" data-now-once>
            <input type="hidden" name="state" value="closed" />
            <input type="hidden" name="reason" value="done" />
            <span
              >Done on main
              ${doneBy.map(
                (oid, n) =>
                  html`${n > 0 ? ", " : "in "}<a
                      href="${repoBase(repo)}/commit/${oid}"
                      ><code>${oid.slice(0, 7)}</code></a
                    >`,
              )}, waiting for you to close it.</span
            >
            ${mayClose
              ? btn("Close", { size: "sm", icon: "issueClosed" })
              : null}
          </form>`,
          { extra: "mt", tone: "success" },
        );
  const [wordInfo, runsCard, closingCard] = await Promise.all([
    direction ? undefined : tellWord(wordCtx, repo, issue, closingPull),
    tellRuns(wordCtx, repo, issue),
    closingPull ? tellClosingPull(ctx, wordCtx, repo, closingPull) : undefined,
  ]);

  const marks = marksByName(db, [issue.authorName, issue.assigneeName ?? ""]);
  const head = html`<div class="page-head">
    <h1>${issue.title} <span class="num">#${issue.number}</span></h1>
    <div class="page-head-sub bar muted small">
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
          : userLink(issue.authorName, { mark: marks.get(issue.authorName) })}
        opened this ${time(issue.createdAt)}</span
      >
      ${when(
        issue.originUrl,
        (url) =>
          html`<a class="bar muted small" href="${url}" rel="noreferrer noopener"
            >${icon("external")}view on origin</a
          >`,
      )}
      ${when(
        issue.sealed,
        () =>
          badge("Sealed security report", { tone: "danger", icon: "lock" }),
      )}
      ${workSpent(ctx, repo, issue.id)}
      ${promiseLine(db, issue)}
      ${!direction && issue.state === "open" && canWrite(db, repo, user)
        ? flowButton(
            `${thread}/flow`,
            labelsFor(db, issue.id).some((l) => l.name.toLowerCase() === FLOW_LABEL),
            thread,
          )
        : null}
      ${issue.assigneeName !== null
        ? html`<span
            >${when(issue.assigneeIsAgent, () => icon("bot"))}
            ${userLink(issue.assigneeName, {
              mark: marks.get(issue.assigneeName),
            })}
            has it</span
          >`
        : null}
    </div>
  </div>`;

  const threadStart = performance.now();
  const talk = conversation(ctx, repo, issue, {
    openVerb: "opened this",
    editAction:
      mayEditIssue(ctx.app, repo, issue, user).ok && repo.origin === null
        ? `${repoBase(repo)}/issues/${issue.number}/edit`
        : undefined,
  });
  const threadMs = performance.now() - threadStart;
  const dependencies = links(() =>
    dependenciesCard(ctx, repo, issue, `${thread}/dependencies`),
  );
  const teams = links(() => issueTeamsCard(ctx, repo, issue, `${thread}/teams`));
  const applied = labelsFor(db, issue.id);
  const allLabels = listLabels(db, repo.id);
  // Closed until asked for: neither is the next thing a person does here,
  // and both are one tap away when it is. What it waits for stays in view
  // above them — one of the three questions the page answers — with its
  // form for whoever may change it.
  const details = disclosure(
    "Details",
    html`${assigneeCard(ctx, repo, issue, `${thread}/assignee`)}
      ${labelsCard(ctx, repo, issue, applied, allLabels, `${thread}/labels`)}
      ${teams}
      ${sealCard(ctx, repo, issue, `${thread}/seal`)}`,
    { extra: "mt" },
  );

  const body = html`<div data-tell>${repoHeader(ctx, repo, "issues", {
      compact: true,
      ownTitle: true,
    })}
    ${head}
    ${heldBanner(ctx, repo, issue)}
    <div class="split">
      <div>
        ${talk.node} ${doneLine}
        ${composer(ctx, {
          action: `${thread}/comments`,
          ...(mayClose ? { stateAction: `${thread}/state` } : {}),
          state: issue.state,
          closeLabel: "Close issue",
          crewNote: threadNote(ctx.app.db, repo, issue),
          reasons: true,
        })}
      </div>
      <aside>
        ${privateWorkCard(ctx, repo, issue, `${thread}/private`)}
        ${hasPicture(db, repo.id, issue.number)
          ? card(
              html`<a href="${thread}/picture"
                  ><img src="${thread}/picture" alt="The page the sender was looking at" loading="lazy" class="tell-picture"
                /></a>`,
              {
                extra: "mt",
                head: html`${icon("eye")}
                  <h2>Picture of the page</h2>`,
              },
            )
          : null}
        ${runsCard}
        ${closingCard}
        ${dependencies}
        ${details}
      </aside>
    </div>
    ${liveMount({
      repo: base,
      thread: "issue",
      number: issue.number,
      lastCommentId: talk.lastCommentId,
    })}</div>`;

  const response = page({
    ctx,
    title: `${issue.title} · ${repo.name}`,
    ogImage: cardPath("issue", repo, issue),
    about: `${repo.ownerName}/${repo.name}#${issue.number}`,
    description: threadLine({
      private: repo.visibility === "private" || issue.sealed,
      word: wordInfo?.word ?? (issue.state === "open" ? "open" : "closed"),
      title: issue.title,
      body: issue.body,
    }),
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: labelCss([...allLabels, ...applied]),
    scriptJs: liveClientJs,
  });
  // Render is what is left of the page's own time once the named phases are out.
  notePhase(request, "thread", threadMs);
  notePhase(request, "links", linksMs);
  notePhase(request, "render", Math.max(0, performance.now() - started - linksMs - threadMs));
  return response;
}

/**
 * Where to fix a sealed report by hand, for a person who may see it: a
 * branch here, or on a public fork, is public — the fix says where the
 * hole is — so the private repository the crew uses is offered (#865).
 */
function privateWorkCard(ctx: Ctx, repo: Repo, issue: Issue, action: string): Html | null {
  const user = ctx.auth.user;
  if (!issue.sealed || user === undefined || user.kind === "agent") return null;
  if (!canSeeSealed(ctx.app.db, repo, user)) return null;
  const mine = getSealedFork(ctx.app.db, user.id, repo.id);
  return card(
    html`<p>
        A branch on ${repo.ownerName}/${repo.name}, or on a public fork, is
        public: its fix shows where the hole is. Fix this one in your private
        repository — only you, this repository's writers and its crew read it
        — and open the pull from there.
      </p>
      ${mine
        ? html`<p class="small">
            Yours: <a href="/${mine.ownerName}/${mine.name}">${mine.ownerName}/${mine.name}</a>
            · push to <code>${ctx.url.origin}/${mine.ownerName}/${mine.name}.git</code>
          </p>`
        : html`<form method="post" action="${action}" class="mt">
            ${btn("Work on this privately", { variant: "primary", icon: "lock" })}
          </form>`}`,
    {
      id: "work-privately",
      head: html`${icon("lock")}
        <h2>Fix it privately</h2>`,
    },
  );
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

/**
 * The promise on an issue, in one line: "live by Fri 07:15 (90%: Fri 11:00) · steward · history
 * says Fri 09:40" (#11955).
 */
function promiseLine(db: Database, issue: Issue): Html | null {
  if (!issue.estimated) return null;
  const words = estimateLine(currentOf(estimatesOf(db, issue.id)), Date.now());
  return words === undefined ? null : html`<span class="estimate" id="estimate-line">${words}</span>`;
}
