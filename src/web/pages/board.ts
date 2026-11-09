/**
 * The board: a live wall of the crews at work, for a second monitor. Four
 * regions — what is being worked on now, what landed, what the decider
 * decided, and today's spend against each app's ceiling with what a shipped
 * change cost over the week — each a live region that swaps itself when a
 * matching event lands. A site admin also gets two strips above them: the
 * forge's health, and each subscription's windows; whoever owns an app gets
 * a line for each thing its crew waits on them for. Nothing on it
 * needs a click, and everything on it links somewhere. It reads the same
 * tables as the studio and adds no state of its own — nor words: every
 * run, change and decision on it is worded by `runWord`/`pullWord`/
 * `tellWord`, the studio's own, and coloured by `wordVariant`.
 *
 * `?wall` is its one wall mode, for a screen across the room that nobody
 * touches: the same regions in larger type, without the key hints or a
 * pointer. The old big view (`/big`, every address it had) lands here.
 */

import { usd } from "../../core/money.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { sentinelNotice } from "../../crew/sentinel.ts";
import { appsForRepos, type AppRecord } from "../../core/apps.ts";
import { ASKS_WINDOW_DAYS, askMeasureWeek, asksMeasureEmpty, asksMeasureParts } from "../../core/ask_ledger.ts";
import { declinedWaits, reviewWaits } from "../../actions/owner_waits.ts";
import { tokenReturns } from "../../core/returns.ts";
import { forgeVitals, needLine } from "../../actions/health.ts";
import { returnsRepos } from "../../actions/returns.ts";
import {
  deciderCounts,
  PILE_EMPTY,
  isDeciderPile,
  listDecisionsForRepos,
  listDeciderPile,
  type DeciderPile,
  type Decision,
  type DecisionKind,
} from "../../core/decisions.ts";
import { deciderSentence } from "../../story/words.ts";
import { efficiencyForRepos } from "../../core/efficiency.ts";
import { reviewStats, type ReviewStats } from "../../core/review-stats.ts";
import { standings, WINDOW_MS } from "../../core/standing.ts";
import {
  listCredentials,
  PLATFORM,
  scopesOf,
  type Subscription,
} from "../../core/subscriptions.ts";
import { readSpend } from "../../actions/spend.ts";
import { spendView } from "./spend.ts";
import type { HandContext } from "../../crew/handover.ts";
import { forgeHealth, rolloutLine } from "../../kernel/guard.ts";
import { coveredByVerdict, forgeVerdict, verdictLine } from "../../kernel/guard_verdict.ts";
import { flakeLine } from "../../checks/flake.ts";
import { laneLine } from "../../kernel/vitals.ts";
import { getIssue, getIssuesByIds, type Issue } from "../../core/issues.ts";
import { looksForApps } from "../../core/looks.ts";
import {
  LATER,
  NO_PILLAR,
  PILLAR_DAYS,
  pillarView,
  reposWithUmbrellas,
} from "../../core/pillars.ts";
import {
  getPull,
  mergedPullCount,
  mergedPullsForRepos,
  openPullsClosing,
  toldBy,
  type Pull,
} from "../../core/pulls.ts";
import {
  listReposVisibleTo,
  ownerFactRepoIds,
  type Repo,
} from "../../core/repos.ts";
import { agentRunTotals, listActiveRuns, type Run } from "../../core/runs.ts";
import { getUsersByIds } from "../../core/users.ts";
import {
  autonomyStatus,
  holdWords,
  plannerHold,
  smallShareOf,
  startOfTodayUtc,
} from "../../crew/autonomy.ts";
import { smallIssuesWords } from "../../crew/small_share.ts";
import { distinct, notesRegion, type Note } from "./board-notes.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { boardJs, liveRegionsJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import {
  avatar,
  badge,
  dot,
  icon,
  kbd,
  listCard,
  meter,
  pill,
  time,
  tokenCount,
} from "../ui.ts";
import { noteLine } from "../studio/note.ts";
import { tellWord } from "../studio/tell.ts";
import { voiceFor } from "../studio/voice.ts";
import { repoDir } from "../../git/repos.ts";
import { perShippedWords } from "../../core/efficiency.ts";
import {
  pausedWords,
  pullWord,
  runWord,
  servingHistory,
  windowWords,
  wordBadge,
  type FigureWords,
  type WordCtx,
} from "../studio/words.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { lookUrl } from "../../core/looks.ts";
import { thumbLook } from "./looks.ts";
import { milestoneHref } from "./milestones.ts";

// ---- words ----

/** Why a run exists, as a person reads it on a card. */
function reasonWords(reason: string): string {
  switch (reason) {
    case "assigned":
      return "building it";
    case "feedback":
      return "on what you said";
    case "check_failed":
      return "fixing the check";
    case "conflict":
      return "catching up with main";
    case "review":
      return "reviewing it";
    case "":
      return "working";
    default:
      return reason.replace(/_/g, " ");
  }
}

const KIND_WORDS: Record<DecisionKind, string> = {
  next: "next issue",
  land: "ship or show",
  retry: "try again",
  lean: "which way",
  hand: "hand-over",
  // Never listed (`listDecisionsForRepos` leaves guards out); named for the type.
  guard: "not started",
};

const money = (n: number): string => `$${n.toFixed(2)}`;

/** A wait, in the unit a person reads it in. */
function waitWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** How review is keeping up on one app today, or null when there is nothing to say. */
function reviewWords(stats: ReviewStats): string | null {
  const parts: string[] = [];
  if (stats.awaiting > 0) parts.push(`${stats.awaiting} awaiting review`);
  if (stats.latencyMs !== null)
    parts.push(`${waitWords(stats.latencyMs)} from green to a verdict`);
  if (stats.byReviewer.length > 0)
    parts.push(
      stats.byReviewer.map((r) => `${r.name} ${r.count}`).join(", "),
    );
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The apps on the board: every one the viewer can see, or the named few. */
interface BoardScope {
  readonly repos: readonly Repo[];
  readonly ids: readonly string[];
  readonly byId: ReadonlyMap<string, Repo>;
  readonly records: ReadonlyMap<string, AppRecord>;
  /** Repos whose spend, runs and decisions this viewer may see — write
   * access, same as the studio. A repo the viewer can only read is on the
   * board (it is still theirs to watch land) but carries none of that. */
  readonly ownerFacts: ReadonlySet<string>;
  /** What the studio's word functions need to see each app's production,
   * every app sharing one render's memo of production's history. */
  readonly words: (repo: Repo) => WordCtx;
}

/** The scope for some repositories: the ones among them that are apps. */
function boardScope(
  ctx: Ctx,
  repos: readonly Repo[],
  records: ReadonlyMap<string, AppRecord>,
): BoardScope {
  const kept = repos.filter((r) => records.has(r.id));
  const runtime = appsRuntime(ctx.app);
  const history = servingHistory();
  const contexts = new Map<string, WordCtx>();
  return {
    repos: kept,
    ids: kept.map((r) => r.id),
    byId: new Map(kept.map((r) => [r.id, r])),
    records,
    ownerFacts: ownerFactRepoIds(ctx.app.db, kept, ctx.auth.user),
    words: (repo) => {
      let made = contexts.get(repo.id);
      if (made === undefined) {
        made = {
          db: ctx.app.db,
          dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
          runtime,
          record: records.get(repo.id),
          history,
          viewer: ctx.auth.user,
        };
        contexts.set(repo.id, made);
      }
      return made;
    },
  };
}

// ---- the page ----

/** GET /board — signed in; every app the viewer can see, or `?apps=` some; `?wall` for the wall mode. */
export async function boardPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const db = ctx.app.db;
  const rq = ctx.request;
  const visible = timePhase(rq, "repos", () => listReposVisibleTo(db, user, { limit: 200 }));
  const records = timePhase(rq, "apps", () =>
    appsForRepos(
      db,
      visible.map((r) => r.id),
    ),
  );
  const wanted = new Set(
    (ctx.url.searchParams.get("apps") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const scope = timePhase(rq, "scope", () =>
    boardScope(
      ctx,
      visible.filter(
        (r) =>
          wanted.size === 0 ||
          wanted.has(r.name.toLowerCase()) ||
          wanted.has(`${r.ownerName}/${r.name}`.toLowerCase()),
      ),
      records,
    ),
  );
  const repos = scope.repos;
  const wall = ctx.url.searchParams.has("wall");
  const forge = timePhase(rq, "forge", () => forgeNotes(ctx));
  const declined = timePhase(rq, "declined", () => declinedNotes(ctx, scope));
  const review = timePhase(rq, "review", () => reviewNotes(ctx, scope));
  const asks = timePhase(rq, "asks", () => asksStrip(ctx));
  const returns = timePhase(rq, "returns", () => returnsStrip(ctx, scope));
  const windows = timePhase(rq, "windows", () => windowsStrip(ctx));
  const workingNow = await timePhaseAsync(rq, "working", () => working(ctx, scope));
  const landedNow = await timePhaseAsync(rq, "landed", () => landed(ctx, scope));
  const decidedNow = await timePhaseAsync(rq, "decided", () => decided(ctx, scope));
  const spendNow = timePhase(rq, "today", () => today(ctx, scope));
  const rendering = performance.now();

  const body = html`<div class="board" ${wall ? html`data-wall=""` : null}>
    <header class="bar">
      <a class="wordmark" href="/"><span class="mark"></span>forge</a>
      <span class="muted small hide-sm" id="board-scope"
        >${
          repos.length === 1
            ? repos[0]!.name
            : `${repos.length} app${repos.length === 1 ? "" : "s"}`
        }</span
      >
      <a class="muted small" href="/asked">What you asked for</a>
      <span class="spacer"></span>
      ${
        wall
          ? null
          : html`<span class="muted small hide-sm" aria-hidden="true"
              >${kbd(["f"])} fullscreen ${kbd(["1"])}–${kbd(["4"])} one region
              ${kbd(["0"])} all</span
            >`
      }
      <span id="board-live" data-state="connecting" title="The live stream"
        >${dot()}</span
      >
      <time class="num small muted" id="board-clock"></time>
    </header>
    ${boardNotes(forge, declined, review)}
    <div class="board-grid">
      ${workingNow} ${landedNow} ${decidedNow}
      ${spendNow}
    </div>
    <div class="stack">
      ${asks}
      ${returns}
      ${windows}
    </div>
  </div>`;
  const res = page({
    ctx,
    title: "Board",
    body,
    bare: true,
    theme: "dark",
    scriptJs: `${liveRegionsJs}\n${boardJs}`,
  });
  notePhase(rq, "render", performance.now() - rendering);
  return res;
}

/**
 * One region: a heading with its key and count, then the list or a quiet
 * line; `lead`, when a region has one, is a line of its own above them.
 */
function region(
  id: string,
  key: string,
  title: string,
  live: string,
  rows: Html[],
  quiet: string,
  lead: Html | null = null,
): Html {
  return html`<section
    class="board-region"
    id="${id}"
    data-live="${live}"
    aria-labelledby="${id}-h"
  >
    <h2 id="${id}-h">
      <kbd aria-hidden="true">${key}</kbd>${title}
      ${when(rows.length > 0, () => pill(rows.length))}
    </h2>
    ${lead}
    ${rows.length === 0 ? html`<p class="muted">${quiet}</p>` : listCard(rows)}
  </section>`;
}

/**
 * One row of a region: §5's list row, keyed so a swap is the same row, with
 * a line of meta for each fact it has — an absent fact is no line — and
 * whatever sits under them (a meter) after.
 */
function boardRow(o: {
  key: string;
  href: string;
  lead?: Html;
  title: Html | string;
  titleAttr?: string;
  meta: readonly (Html | string | null)[];
  under?: Html;
  trail?: Html;
}): Html {
  return html`<li>
    <a class="row" data-key="${o.key}" href="${o.href}">
      ${o.lead ? html`<span class="row-lead">${o.lead}</span>` : null}
      <span class="row-main">
        <span class="row-title" ${o.titleAttr ? html`title="${o.titleAttr}"` : null}
          >${o.title}</span
        >
        ${o.meta.map((m) => (m === null ? null : html`<span class="row-meta">${m}</span>`))}
        ${o.under ?? null}
      </span>
      ${o.trail ? html`<span class="row-trail">${o.trail}</span>` : null}
    </a>
  </li>`;
}

/** An app's address as the big view wrote it: `owner/name`, nothing else. */
const APP_SLUG = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * GET /big — the big view, folded into the board. Every address it had
 * (`?app=`, `&list=`, `?run=`, `?view=board|map`) lands on the wall mode;
 * an app it named stays the scope, as `?apps=`. The board decides what the
 * viewer may see, so this reads nothing and says nothing about what exists.
 */
export function bigRedirect(ctx: Ctx): Response {
  const app = ctx.url.searchParams.get("app") ?? "";
  return redirect(
    APP_SLUG.test(app)
      ? `/board?apps=${encodeURIComponent(app)}&wall`
      : "/board?wall",
  );
}

// ---- the forge ----

/**
 * The forge's health as notes, for a site admin only: each thing that needs
 * them, and the lane when checks are queued. Nobody else pays for the reads.
 */
function forgeNotes(ctx: Ctx): { notes: Note[]; ok: boolean } | null {
  if (!ctx.auth.user?.isAdmin) return null;
  const v = forgeVitals(ctx.app);
  const fh = forgeHealth();
  const verdict = forgeVerdict(fh, Date.now());
  const said = (line: string) => coveredByVerdict(line, verdict, fh);
  const rollout = rolloutLine(fh);
  const others = fh.incidents.filter((i) => !said(`${i.key}: ${i.message}`));
  const ok = v.ok && fh.ok && verdict === undefined;
  const lane = laneLine(v.lane);
  const flaky = flakeLine(v.flakes);
  const sentinel = sentinelNotice(ctx.app.db);
  const need = (key: string, line: Html): Note => ({ key, need: true, line });
  const notes: Note[] = [
    ...(sentinel === null
      ? []
      : [need("sentinel", html`<a data-need id="sentinel" href="${sentinel.href}">${dot("attn")} ${sentinel.text}</a>`)]),
    ...(rollout === null || said(rollout)
      ? []
      : [need("rollout", html`<span data-need>${dot("attn")} ${rollout}</span>`)]),
    ...(verdict === undefined
      ? []
      : [need("verdict", html`<span data-need>${dot("attn")} ${verdictLine(verdict)}</span>`)]),
    ...others.map((i) => need(`incident:${i.key}`, html`<span data-need>${dot("attn")} ${i.key}: ${i.message}</span>`)),
    ...(ok
      ? []
      : v.degraded.map((d) =>
          need(`degraded:${d.cause}`, html`<a data-need href="${d.href}">${dot("attn")} ${needLine(d)}</a>`),
        )),
    ...(lane === null ? [] : [{ key: "lane", need: false, line: html`<span>Lane: ${lane}</span>` }]),
    ...(flaky === null ? [] : [{ key: "flakes", need: false, line: html`<span data-flakes>Flaky this week: ${flaky}</span>` }]),
  ];
  return { notes, ok };
}

// ---- agent pulls that wait for a person's review ----

/** The review waits (#597) as notes: owner facts only, one per app. */
function reviewNotes(ctx: Ctx, scope: BoardScope): Note[] {
  const owned = scope.repos.filter((r) => scope.ownerFacts.has(r.id));
  return reviewWaits(ctx.app.db, owned).flatMap((w): Note[] =>
    w.kind !== "review"
      ? []
      : [
          {
            key: `review:${w.repo.id}`,
            need: true,
            line: html`<a data-need href="/asks"
              >${dot("attn")} <b>${w.repo.name}</b>: ${w.none ? "No reviewer: agent pulls wait for you" : w.paused ? "The reviewer is paused: agent pulls wait for you" : "agent pulls wait for your review"}${w.waiting === 0 || w.since === null
                ? null
                : html` · <b>${w.waiting}</b> waiting since ${w.since.slice(0, 10)}`}</a
            >`,
          },
        ],
  );
}

// ---- what asked you, and what came of it ----

/**
 * The viewer's asks over the last week, as four figures: raised, acted on,
 * dismissed, and gone by themselves. Many dismissed against few acted on
 * is noise, shown as a number (`core/ask_ledger.ts`). Absent before
 * anything has asked.
 */
function asksStrip(ctx: Ctx): Html | null {
  const user = ctx.auth.user;
  if (!user) return null;
  const m = askMeasureWeek(ctx.app.db, user.id);
  if (asksMeasureEmpty(m)) return null;
  return html`<a class="muted small" id="asks-measure" href="/asks"
    >Asks, ${ASKS_WINDOW_DAYS} days: ${asksMeasureParts(m).map(
      (p, i) => html`${i === 0 ? "" : " · "}<b>${p.n}</b> ${p.label}`,
    )}</a
  >`;
}

// ---- what the tokens bought ----


/**
 * The week's spend against what it landed, in one line, owner facts only:
 * dollars spent, changes landed, what a landed change cost, and what did
 * not land, split in two: closed with nothing merged (spent, and gone) and
 * still open (not yet an answer) — one tap to the breakdown
 * (`/board/returns`). Where "Spend by credential…" says where the money
 * went, this says what it bought. Absent when the
 * viewer holds no owner facts here or nothing ran.
 */
function returnsStrip(ctx: Ctx, scope: BoardScope): Html | null {
  const user = ctx.auth.user;
  if (!user) return null;
  // The crew spends on every repository, app or not: the whole of the
  // viewer's own unless `?apps=` narrows the board.
  const apps = ctx.url.searchParams.get("apps");
  const ids = apps
    ? scope.repos.filter((r) => scope.ownerFacts.has(r.id)).map((r) => r.id)
    : returnsRepos(ctx.app, user).map((r) => r.id);
  if (ids.length === 0) return null;
  const now = Date.now();
  const r = tokenReturns(ctx.app.db, ids, {
    since: new Date(now - ASKS_WINDOW_DAYS * 86_400_000).toISOString(),
    until: new Date(now).toISOString(),
  });
  if (r.spent.runs === 0) return null;
  const href = `/board/returns${apps ? `?apps=${encodeURIComponent(apps)}` : ""}`;
  return html`<a class="muted small" id="returns-line" href="${href}"
    >Tokens, ${ASKS_WINDOW_DAYS} days: <b>${usd(r.spent.usd)}</b> → <b>${r.landed}</b> landed
    ${r.onLanded.perChange.changes === 0
      ? null
      : html`· <b>${usd(r.onLanded.perChange.median)}</b> a landed change`}
    · <b>${usd(r.landedNothing.closed.usd)}</b> closed with nothing
    · <b>${usd(r.landedNothing.open.usd)}</b> still open</a
  >`;
}

// ---- the planner, waiting for a person ----

/**
 * One note per app whose planner declined the direction: that it waits for
 * the owner, a link to the run that declined (where the words are) and a
 * box to answer it: a comment on the direction issue. Only
 * for apps whose owner facts the viewer may see. An issue the crew parked
 * twice is the planner's business and is not here (it is on the map).
 */
function declinedNotes(ctx: Ctx, scope: BoardScope): Note[] {
  const owned = scope.repos.filter((r) => scope.ownerFacts.has(r.id));
  return declinedWaits(ctx.app.db, owned).flatMap((d) => d.kind !== "declined" ? [] : [{
    key: `declined:${d.repo.id}`,
    need: true,
    line: html`<form
      class="edit-row"
      data-need
      method="post"
      action="${repoBase(d.repo)}/issues/${d.issue.number}/comments"
    >
      <span class="grow"
        >${dot("attn")} <b>${d.repo.name}</b>: the planner declined the direction
        and waits for you — <a href="${repoBase(d.repo)}/runs/${d.runId}">why</a></span
      >
      <input type="hidden" name="back" value="board" />
      <input
        class="input"
        name="body"
        required
        aria-label="Answer the planner on #${d.issue.number}"
        placeholder="Answer the planner"
      />
      <button class="btn" type="submit">Answer</button>
    </form>`,
  }]);
}

/** Every note for this viewer, as the one live region under the title. */
function boardNotes(
  forge: ReturnType<typeof forgeNotes>,
  declined: readonly Note[],
  review: readonly Note[],
): Html {
  const notes = distinct([...(forge?.notes ?? []), ...declined, ...review]);
  return notesRegion(notes, {
    fine: forge !== null && forge.ok,
    live: "run.queued,run.started,run.finished,issue.*,pull.*,app.*",
    ok: forge === null ? null : forge.ok,
  });
}

// ---- the subscriptions' windows ----

/** Figures in a row, `inferred` said once when every one is, else on each. */
function figures(parts: readonly FigureWords[]): Html {
  const all = parts.every((p) => p.inferred);
  const tag = badge("inferred", { variant: "outline" });
  return html`${parts.map(
    (p, n) =>
      html`${n > 0 ? " · " : null}<span
          >${p.text}${when(!all && p.inferred, () => html` ${tag}`)}</span
        >`,
  )}${when(all, () => html` ${tag}`)}`;
}

/**
 * Each credential's 5-hour and weekly window — used, left, resets — and the
 * crew's spend broken down, for a site admin only: the pool is theirs
 * (`/settings/subscriptions`). The platform's token leads: it is the crew's.
 * Then the accounts with a scope, then those with none — a person's own
 * plan, never offered to the crew, its numbers kept apart so they never
 * read as idle crew capacity. A fixed number of statements however many
 * accounts (`standings`, `scopesOf`). A live region of its own.
 */
function windowsStrip(ctx: Ctx): Html | null {
  if (!ctx.auth.user?.isAdmin) return null;
  const db = ctx.app.db;
  const pool = listCredentials(db);
  if (pool.length === 0) return null;
  const now = new Date();
  const all = standings(
    db,
    pool.map((s) => s.id),
    now,
  );
  const scopes = scopesOf(db);
  const scopeWords = (id: string): string =>
    id === PLATFORM
      ? "every app no subscription is granted to"
      : (scopes.get(id) ?? []).join(", ");
  const row = (s: Subscription): Html | null => {
    const st = all.get(s.id);
    if (st === undefined) return null;
    return html`<a
      class="bar small muted"
      href="/settings/subscriptions"
      data-key="sub:${s.id}"
    >
      <b>${s.name}</b>
      ${st.windows.map((w) => {
        const words = windowWords(w);
        return html`<span class="bar" data-window="${w.window}"
          >${words.name}
          ${
            words.usedPct === null
              ? null
              : meter(
                  words.usedPct,
                  `${words.name} used`,
                  words.usedPct >= 100 ? "attn" : undefined,
                )
          }
          <span class="num"
            >${figures([words.used, words.remaining, words.resets])}${when(
              w.tokensIn + w.tokensOut > 0,
              () => html` · ${tokenCount(w.tokensIn + w.tokensOut, "counted")}`,
            )}</span
          ></span
        >`;
      })}
      ${when(scopeWords(s.id) !== "", () => html`<span>for ${scopeWords(s.id)}</span>`)}
    </a>`;
  };
  const crew = pool.filter((s) => s.id === PLATFORM || scopes.has(s.id));
  const apart = pool.filter((s) => s.id !== PLATFORM && !scopes.has(s.id));
  const group = (name: string, key: string, subs: readonly Subscription[]): Html =>
    html`<div class="stack stack-tight" data-group="${key}">
      <span class="muted small">${name}</span>${subs.map(row)}
    </div>`;
  return html`<div
    class="stack"
    id="windows"
    data-live="run.queued,run.started,run.finished,usage.*"
    aria-label="Subscription windows"
  >
    ${group("The crew's", "crew", crew)}
    ${when(apart.length > 0, () => group("Not offered to the crew", "apart", apart))}
    <details id="spend-detail">
      <summary class="muted small">Spend by credential, app, agent, issue and kind</summary>
      ${spendView(readSpend(ctx.app, now))}
    </details>
  </div>`;
}

// ---- working now ----

async function working(ctx: Ctx, scope: BoardScope): Promise<Html> {
  const db = ctx.app.db;
  const runs = listActiveRuns(db, scope.ids);
  // Working first, by when it started; then what waits, by when it was queued.
  const at = (r: Run): string => r.startedAt ?? r.createdAt;
  runs.sort((a, b) => {
    if ((a.state === "running") !== (b.state === "running"))
      return a.state === "running" ? -1 : 1;
    return at(a).localeCompare(at(b));
  });
  const actors = getUsersByIds(
    db,
    runs.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const about = getIssuesByIds(
    db,
    runs.map((r) => r.issueId).filter((id): id is string => id !== null),
  );
  const words = await Promise.all(
    runs.map((run) => runWord(scope.words(scope.byId.get(run.repoId)!), run)),
  );
  const rows = runs.map((run, n) => {
    const repo = scope.byId.get(run.repoId)!;
    // The same rule the app's page signs its rows by, `voiceFor`
    // (`studio/voice.ts`): the crew's own work reads as the app's own story
    // for a viewer who cannot see the roster; a person is always named.
    const actor = run.actorId === null ? undefined : actors.get(run.actorId);
    const who = voiceFor(
      {
        name: actor?.username,
        isAgent: actor === undefined || actor.kind === "agent",
      },
      scope.ownerFacts.has(repo.id),
    );
    const issue = run.issueId === null ? undefined : about.get(run.issueId);
    const { word, note } = words[n]!;
    return boardRow({
      key: `run:${run.id}`,
      href: `${repoBase(repo)}/runs/${run.id}`,
      lead: avatar(who, "md"),
      title: issue?.title ?? (run.summary || "on the repository"),
      titleAttr: issue?.title ?? run.summary,
      meta: [
        html`<b>${who}</b> · ${repo.name} ·
          ${run.notBefore === null ? reasonWords(run.reason) : note}${when(
            run.costUsd > 0 && scope.ownerFacts.has(repo.id),
            () => html` · <span class="num">${money(run.costUsd)}</span>`,
          )}`,
      ],
      trail: html`${wordBadge(word)}<span
          class="num"
          data-started="${at(run)}"
        ></span>`,
    });
  });
  return region(
    "working",
    "1",
    "Working now",
    "run.queued,run.started,run.finished",
    rows,
    scope.repos.length === 0
      ? "No apps to watch."
      : "Nobody is working right now.",
  );
}

// ---- landed ----

async function landed(ctx: Ctx, scope: BoardScope): Promise<Html> {
  const db = ctx.app.db;
  const pulls = mergedPullsForRepos(db, scope.ids, 12);
  // The newest production picture of each app, on a phone, in one read.
  const looks = looksForApps(
    db,
    scope.repos
      .map((r) => scope.records.get(r.id)?.id)
      .filter((id): id is string => id !== undefined),
  );
  const pictureOf = (repo: Repo): string | undefined => {
    const record = scope.records.get(repo.id);
    if (record === undefined) return undefined;
    const look = thumbLook(
      ctx,
      repo,
      record,
      looks.filter((l) => l.appId === record.id && l.env === "production"),
    );
    return (
      look &&
      lookUrl(repoBase(repo), look)
    );
  };
  const words = await Promise.all(
    pulls.map((pull) => pullWord(scope.words(scope.byId.get(pull.repoId)!), pull)),
  );
  const rows = pulls.map((pull: Pull, n) => {
    const repo = scope.byId.get(pull.repoId)!;
    const picture = pictureOf(repo);
    const author = voiceFor(
      { name: pull.authorName, isAgent: pull.authorIsAgent },
      scope.ownerFacts.has(repo.id),
    );
    const told = toldBy(db, pull);
    return boardRow({
      key: `pull:${pull.id}`,
      href: `${repoBase(repo)}/pulls/${pull.number}`,
      lead:
        picture === undefined
          ? icon("merge")
          : html`<img src="${picture}" width="34" height="46" alt="" loading="lazy" />`,
      title: pull.title,
      titleAttr: pull.title,
      meta: [html`${repo.name} · ${author}${told === null ? "" : html` · told by ${told}`}`],
      trail: html`${wordBadge(words[n]!.word)}${time(pull.mergedAt ?? pull.createdAt)}`,
    });
  });
  return region(
    "landed",
    "2",
    "Landed",
    "pull.merged,run.finished",
    rows,
    scope.repos.length === 0 ? "No apps to watch." : "Nothing has shipped yet.",
    byPillar(ctx, scope),
  );
}

/**
 * What merged in the last 7 days, by pillar, for each app that has
 * pillars: is the crew building what was asked. Every pillar is named,
 * zero or not — a pillar nothing merged for is the answer too — and each
 * is a link to its issues. Nothing for a board whose apps have no pillars.
 */
function byPillar(ctx: Ctx, scope: BoardScope): Html | null {
  const db = ctx.app.db;
  const having = reposWithUmbrellas(db, scope.ids);
  const lines = scope.repos.flatMap((repo) => {
    if (!having.has(repo.id)) return [];
    const view = pillarView(db, repo);
    if (view === undefined) return [];
    const base = repoBase(repo);
    // One tap to how far a pillar is: its umbrella's milestone.
    const umbrella = new Map<string, number>(
      view.set.pillars.map((p) => [p.name, p.umbrella.number]),
    );
    if (view.set.later !== undefined)
      umbrella.set(LATER, view.set.later.number);
    const hrefOf = (name: string): string =>
      umbrella.has(name)
        ? milestoneHref(base, umbrella.get(name)!)
        : `${base}/issues?label=${encodeURIComponent(name)}`;
    return [
      html`<p class="bar small muted" data-pillars="" data-app="${repo.name}">
        <span
          >${scope.repos.length === 1 ? "" : `${repo.name} · `}merged in
          ${PILLAR_DAYS} days</span
        >
        ${view.merged.map((count) =>
          count.pillar === null
            ? html`<span data-zero="no">${NO_PILLAR} <b>${count.merged}</b></span>`
            : html`<a
                data-zero="${count.merged === 0 ? "yes" : "no"}"
                href="${hrefOf(count.pillar)}"
                >${count.pillar} <b>${count.merged}</b></a
              >`,
        )}
      </p>`,
    ];
  });
  return lines.length === 0 ? null : html`${lines}`;
}

// ---- decided ----

/** A hand-over's row says why, and what the decider saw (`crew/handover.ts`). */
function handContextLine(d: Decision): string {
  const s = d.state as Partial<HandContext> & { reason?: string };
  const seen = [
    // One person's pins and mutes stay out of a line other owners read.
    s.spend === undefined
      ? null
      : `${money(s.spend.todayUsd)} of ${money(s.spend.ceilingUsd)} today`,
    `${s.recent?.length ?? 0} past decisions`,
    `${s.evidence?.reasons.length ?? 0} park notes`,
  ].filter((x): x is string => x !== null);
  return `${s.reason ?? d.answer} Saw: ${s.direction ? `the direction, ` : ""}${seen.join(", ")}.`;
}

/** The most rows a ledger view lists; past it the view says how many it left out. */
const LEDGER_ROWS = 200;

const PILE_LEAD: Record<DeciderPile, string> = {
  closed: "What the decider closed today.",
  deferred: "What the decider held back today.",
  asked: "What the decider asked you about today.",
};

async function decided(ctx: Ctx, scope: BoardScope): Promise<Html> {
  const db = ctx.app.db;
  // The decision ledger is the owner's own record of what the crew chose —
  // never shown for a repository this viewer can only read.
  const ids = scope.repos
    .filter((r) => scope.ownerFacts.has(r.id))
    .map((r) => r.id);
  // `?ledger=closed|deferred|asked` is the rows behind a count on Today's line.
  const asked = ctx.url.searchParams.get("ledger");
  const pile = isDeciderPile(asked) ? asked : null;
  const since = startOfTodayUtc(new Date()).toISOString();
  const decisions =
    pile === null
      ? listDecisionsForRepos(db, ids, 12)
      : listDeciderPile(db, ids, pile, since, LEDGER_ROWS);
  const total = pile === null ? 0 : deciderCounts(db, ids, since)[pile];
  const about = getIssuesByIds(
    db,
    decisions.map((d) => d.issueId).filter((id): id is string => id !== null),
  );
  // What each decision was about: the issue picked for `next`, the pull
  // for the rest. A pick names its issue by number.
  const subjects = decisions.map((d): Issue | undefined => {
    const issue = d.issueId === null ? undefined : about.get(d.issueId);
    if (d.kind === "next" && /^\d+$/.test(d.answer))
      return getIssue(db, d.repoId, Number(d.answer)) ?? issue;
    return issue;
  });
  // What came of it is where that pull or tell stands now, in the studio's
  // own words — never the ledger's private outcome, so a merge production
  // has not served yet reads *waiting* here as it does on the app's page.
  const closing = new Map<string, Map<number, Pull>>();
  const words = await Promise.all(
    decisions.map(async (d, n) => {
      const issue = subjects[n];
      if (issue === undefined) return undefined;
      const repo = scope.byId.get(d.repoId)!;
      const wordCtx = scope.words(repo);
      if (issue.kind === "pull") {
        const pull = getPull(db, repo.id, issue.number);
        return pull && (await pullWord(wordCtx, pull));
      }
      let pulls = closing.get(repo.id);
      if (pulls === undefined) {
        pulls = openPullsClosing(db, repo.id);
        closing.set(repo.id, pulls);
      }
      return await tellWord(wordCtx, repo, issue, pulls.get(issue.number));
    }),
  );
  const rows = decisions.map((d: Decision, n) => {
    const repo = scope.byId.get(d.repoId)!;
    const base = repoBase(repo);
    const issue = subjects[n];
    const word = words[n]?.word;
    const href =
      issue === undefined
        ? base
        : `${base}/${issue.kind === "pull" ? "pulls" : "issues"}/${issue.number}`;
    const answer =
      d.kind === "next" && issue !== undefined ? `#${issue.number}` : d.answer;
    const sure = Math.round(d.p * 100);
    const hand = d.kind === "hand" ? handContextLine(d) : null;
    return boardRow({
      key: `decision:${d.id}`,
      href,
      title: answer,
      meta: [
        `${KIND_WORDS[d.kind]} · ${issue?.title ?? repo.name} · ${d.by === "rule" ? "by the rule" : `by ${d.by}`}`,
        hand === null ? null : noteLine(hand),
      ],
      under: meter(sure, `${sure}% sure`),
      trail: html`${
        word === undefined ? html`<span class="muted">—</span>` : wordBadge(word)
      }<span class="num muted small" title="${sure}% sure">${sure}%</span>${time(d.createdAt)}`,
    });
  });
  return region(
    "decided",
    "3",
    "Decided",
    "run.queued,run.started,run.finished,pull.*",
    rows,
    pile === null ? "Nothing decided yet." : PILE_EMPTY[pile],
    pile === null
      ? null
      : html`<p class="muted small">
          ${PILE_LEAD[pile]}${total > decisions.length
            ? ` Showing the newest ${decisions.length} of ${total}.`
            : ""}
          <a href="${boardHref(ctx, null)}#decided">All decisions</a>
        </p>`,
  );
}

// ---- today ----

/** The board's own address, keeping `?apps=`, with a ledger pile (or none) in `?ledger=`. */
function boardHref(ctx: Ctx, pile: DeciderPile | null): string {
  const q = new URLSearchParams();
  const apps = ctx.url.searchParams.get("apps");
  if (apps) q.set("apps", apps);
  if (pile !== null) q.set("ledger", pile);
  const s = q.toString();
  return s === "" ? "/board" : `/board?${s}`;
}

/** `deciderSentence` with today's counts, each count a link to its ledger rows; null on a quiet day. */
function deciderLine(ctx: Ctx, scope: BoardScope, since: string): Html | null {
  const n = deciderCounts(ctx.app.db, [...scope.ownerFacts], since);
  if (n.closed + n.deferred + n.asked === 0) return null;
  const link = (pile: DeciderPile) =>
    html`<a href="${boardHref(ctx, pile)}#decided">${n[pile]}</a>`;
  return html`<p class="muted small" id="decider-day">
    ${deciderSentence(link)}
  </p>`;
}

function today(ctx: Ctx, scope: BoardScope): Html {
  const db = ctx.app.db;
  const now = new Date();
  const since = startOfTodayUtc(now).toISOString();
  // Spend per shipped change over the weekly window, every app in one read.
  const week = efficiencyForRepos(
    db,
    [...scope.ownerFacts],
    new Date(now.getTime() - WINDOW_MS.week).toISOString(),
  );
  // Today's spend against the ceiling is the owner's own dashboard: each
  // app that runs on its own, and any other the crew spent on this week.
  const rows = scope.repos
    .filter(
      (r) =>
        scope.ownerFacts.has(r.id) && (r.autonomy !== "off" || week.has(r.id)),
    )
    .map((repo) => {
      const s = autonomyStatus(ctx.app, repo);
      // The app page's own reads (`studio/app.ts`), over today rather
      // than the week: counted by the database, not off a page of rows.
      const runs = agentRunTotals(db, repo.id, since).runs;
      const shipped = mergedPullCount(db, repo.id, since);
      const share = s.ceilingUsd > 0 ? s.spentTodayUsd / s.ceilingUsd : 0;
      const review = reviewWords(reviewStats(db, repo.id, since));
      const held =
        repo.autonomy === "autonomous" ? plannerHold(ctx.app, repo, now) : null;
      const holdLine = held === null ? null : holdWords(held);
      const note = s.paused === null ? repo.autonomy : pausedWords(s.paused);
      return boardRow({
        key: `app:${repo.ownerName}/${repo.name}`,
        href: repoBase(repo),
        title: html`${repo.name}
          ${s.paused === null
            ? html`<span class="muted small">${note}</span>`
            : badge(note, { tone: "attn" })}`,
        meta: [
          html`<span><b>${money(s.spentTodayUsd)}</b> of $${s.ceilingUsd.toFixed(0)}</span>
            · <span><b>${runs}</b> run${runs === 1 ? "" : "s"}</span> ·
            <span><b>${shipped}</b> shipped</span>`,
          `${perShippedWords(week.get(repo.id))} this week`,
          holdLine,
          // Small issues in flight of the slots they may hold (#7571).
          repo.autonomy === "off" ? null : smallIssuesWords(smallShareOf(ctx.app, repo, now)),
          review,
        ],
        under: meter(
          share * 100,
          `${money(s.spentTodayUsd)} of its $${s.ceilingUsd.toFixed(0)} ceiling today`,
          s.paused === "ceiling" ? "attn" : undefined,
        ),
      });
    });
  return region(
    "today",
    "4",
    "Today",
    "run.queued,run.started,run.finished,pull.merged",
    rows,
    scope.repos.length === 0
      ? "No apps to watch."
      : "No app runs on its own yet.",
    deciderLine(ctx, scope, since),
  );
}

// The board's stylesheet lives in `board_style.ts`, so `web/style.ts` can
// read it without loading this page's data graph.
export { boardCss } from "./board_style.ts";
