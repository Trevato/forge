/**
 * The board: a live wall of the crews at work, for a second monitor. Four
 * regions — what is being worked on now, what landed, what the decider
 * decided, and today's spend against each app's ceiling with what a shipped
 * change cost over the week — each a live region that swaps itself when a
 * matching event lands. A site admin also gets two strips above them: the
 * forge's health, and each subscription's windows. Nothing on it
 * needs a click, and everything on it links somewhere. It reads the same
 * tables as the studio and adds no state of its own.
 *
 * `?wall` is its one wall mode, for a screen across the room that nobody
 * touches: the same regions in larger type, without the key hints or a
 * pointer. The old big view (`/big`, every address it had) lands here.
 */

import { appsForRepos, type AppRecord } from "../../core/apps.ts";
import { askMeasure } from "../../core/ask_ledger.ts";
import { tokenReturns } from "../../core/returns.ts";
import {
  listDecisionsForRepos,
  type Decision,
  type DecisionKind,
} from "../../core/decisions.ts";
import { appsRuntime } from "../../apps/runtime.ts";
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
import { listApps } from "../../core/apps.ts";
import { forgeHealth, rolloutLine } from "../../kernel/guard.ts";
import { vitals, type Vitals } from "../../kernel/vitals.ts";
import { getIssue, getIssuesByIds, type Issue } from "../../core/issues.ts";
import { looksForApps } from "../../core/looks.ts";
import { listPulls, mergedPullsForRepos, toldBy, type Pull } from "../../core/pulls.ts";
import {
  listReposVisibleTo,
  ownerFactRepoIds,
  type Repo,
} from "../../core/repos.ts";
import { listActiveRuns, listRuns, type Run } from "../../core/runs.ts";
import { getUsersByIds } from "../../core/users.ts";
import {
  autonomyStatus,
  plannerDeclines,
  startOfTodayUtc,
} from "../../crew/autonomy.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase, signInFirst } from "../chrome.ts";
import { boardJs, liveRegionsJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { avatar, icon, time, tokenCount } from "../ui.ts";
import { voiceFor } from "../studio/voice.ts";
import {
  perShippedWords,
  windowWords,
  type FigureWords,
} from "../studio/words.ts";
import { lookUrl } from "../../core/looks.ts";
import { thumbLook } from "./looks.ts";

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

type StateWord = "queued" | "working" | "paused";

function stateWord(run: Run): StateWord {
  if (run.state === "running") return "working";
  return run.notBefore === null ? "queued" : "paused";
}

const KIND_WORDS: Record<DecisionKind, string> = {
  next: "next issue",
  land: "ship or show",
  retry: "try again",
  lean: "which way",
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

/** A whole percentage, for the width rules in `boardCss`. */
const pct = (n: number): number =>
  Math.max(0, Math.min(100, Math.round(n * 100)));

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
}

/** The scope for some repositories: the ones among them that are apps. */
function boardScope(
  ctx: Ctx,
  repos: readonly Repo[],
  records: ReadonlyMap<string, AppRecord>,
): BoardScope {
  const kept = repos.filter((r) => records.has(r.id));
  return {
    repos: kept,
    ids: kept.map((r) => r.id),
    byId: new Map(kept.map((r) => [r.id, r])),
    records,
    ownerFacts: ownerFactRepoIds(ctx.app.db, kept, ctx.auth.user),
  };
}

// ---- the page ----

/** GET /board — signed in; every app the viewer can see, or `?apps=` some; `?wall` for the wall mode. */
export function boardPage(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const db = ctx.app.db;
  const visible = listReposVisibleTo(db, user, { limit: 200 });
  const records = appsForRepos(
    db,
    visible.map((r) => r.id),
  );
  const wanted = new Set(
    (ctx.url.searchParams.get("apps") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const scope = boardScope(
    ctx,
    visible.filter(
      (r) =>
        wanted.size === 0 ||
        wanted.has(r.name.toLowerCase()) ||
        wanted.has(`${r.ownerName}/${r.name}`.toLowerCase()),
    ),
    records,
  );
  const repos = scope.repos;
  const wall = ctx.url.searchParams.has("wall");

  const body = html`<div class="board" ${wall ? html`data-wall=""` : null}>
    <header class="board-top">
      <a class="board-brand" href="/"><span class="mark"></span>forge</a>
      <span class="board-scope"
        >${
          repos.length === 1
            ? repos[0]!.name
            : `${repos.length} app${repos.length === 1 ? "" : "s"}`
        }</span
      >
      <a class="board-asked" href="/asked">What you asked for</a>
      <span class="spacer"></span>
      <span class="board-keys" aria-hidden="true"
        ><kbd>f</kbd> fullscreen <kbd>1</kbd>–<kbd>4</kbd> one region
        <kbd>0</kbd> all</span
      >
      <span
        class="board-live"
        id="board-live"
        data-state="connecting"
        title="The live stream"
        ><span class="board-dot"></span
      ></span>
      <time class="board-clock" id="board-clock"></time>
    </header>
    ${forgeStrip(ctx)} ${declinedStrip(ctx, scope)} ${asksStrip(ctx)}
    ${returnsStrip(ctx, scope)}
    ${windowsStrip(ctx)}
    <div class="board-grid">
      ${working(ctx, scope)} ${landed(ctx, scope)} ${decided(ctx, scope)}
      ${today(ctx, scope)}
    </div>
  </div>`;
  return page({
    ctx,
    title: "Board",
    body,
    bare: true,
    theme: "dark",
    scriptJs: `${liveRegionsJs}\n${boardJs}`,
  });
}

/** One region: a heading with its key and count, then the list or a quiet line. */
function region(
  id: string,
  key: string,
  title: string,
  live: string,
  rows: Html[],
  quiet: string,
): Html {
  return html`<section
    class="board-region"
    id="${id}"
    data-live="${live}"
    aria-labelledby="${id}-h"
  >
    <h2 class="board-h" id="${id}-h">
      <span class="board-key" aria-hidden="true">${key}</span>${title}
      ${when(
        rows.length > 0,
        () => html`<span class="board-count">${rows.length}</span>`,
      )}
    </h2>
    ${
      rows.length === 0
        ? html`<p class="board-quiet">${quiet}</p>`
        : html`<ul class="board-list">
            ${rows}
          </ul>`
    }
  </section>`;
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

/** Where a need can be acted on, when it can: a stuck run's page. */
function needHref(need: string, v: Vitals): string | undefined {
  if (/ stuck\.$/.test(need) && v.stuck[0] !== undefined)
    return `/${v.stuck[0].repo}/runs/${v.stuck[0].runId}`;
  return undefined;
}

/**
 * The forge's health as one line, for a site admin only: *All fine*, or
 * each thing that needs them. A live region of its own; nobody else gets
 * the element or pays for the reads.
 */
function forgeStrip(ctx: Ctx): Html | null {
  if (!ctx.auth.user?.isAdmin) return null;
  const app = ctx.app;
  const runtime = appsRuntime(app);
  const v = vitals({
    db: app.db,
    dataDir: app.config.dataDir,
    envs: runtime
      ? listApps(app.db).flatMap((record) => runtime.status(record))
      : [],
  });
  const fh = forgeHealth();
  const rollout = rolloutLine(fh);
  const others = fh.incidents.filter(
    (i) => i.key !== "stuck" && i.key !== "held",
  );
  const ok = v.ok && fh.ok;
  return html`<div
    class="board-forge"
    id="forge"
    data-live="run.*,app.*"
    data-ok="${ok ? "yes" : "no"}"
    data-rollout="${fh.rollout.state}"
    role="status"
  >
    ${rollout === null ? "" : html`<span class="board-forge-need">${rollout}</span>`}
    ${others.map((i) => html`<span class="board-forge-need">${i.key}: ${i.message}</span>`)}
    ${
      ok
        ? html`<span class="board-forge-ok">All fine</span>`
        : v.needs.map((need) => {
            const href = needHref(need, v);
            return href === undefined
              ? html`<span class="board-forge-need">${need}</span>`
              : html`<a class="board-forge-need" href="${href}">${need}</a>`;
          })
    }
  </div>`;
}

// ---- what asked you, and what came of it ----

/** The window the asks measure covers. */
export const ASKS_WINDOW_DAYS = 7;

/**
 * The viewer's asks over the last week, as four figures: raised, acted on,
 * dismissed, and gone by themselves. Many dismissed against few acted on
 * is noise, shown as a number (`core/ask_ledger.ts`). Absent before
 * anything has asked.
 */
function asksStrip(ctx: Ctx): Html | null {
  const user = ctx.auth.user;
  if (!user) return null;
  const since = new Date(Date.now() - ASKS_WINDOW_DAYS * 86_400_000).toISOString();
  const m = askMeasure(ctx.app.db, user.id, since);
  if (m.raised + m.acted + m.dismissed + m.expired === 0) return null;
  return html`<a class="board-asks" id="asks-measure" href="/asks"
    >Asks, ${ASKS_WINDOW_DAYS} days: <b>${m.raised}</b> raised · <b>${m.acted}</b> acted
    on · <b>${m.dismissed}</b> dismissed · <b>${m.expired}</b> went by themselves</a
  >`;
}

// ---- what the tokens bought ----

/** Dollars as the board writes them: cents under ten, whole above. */
export const usd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

/**
 * The week's spend against what it landed, in one line, owner facts only:
 * dollars spent, changes landed, what a landed change cost, and what landed
 * nothing — one tap to the breakdown (`/board/returns`). Absent when the
 * viewer holds no owner facts here or nothing ran.
 */
function returnsStrip(ctx: Ctx, scope: BoardScope): Html | null {
  const ids = scope.repos.filter((r) => scope.ownerFacts.has(r.id)).map((r) => r.id);
  if (ids.length === 0) return null;
  const now = Date.now();
  const r = tokenReturns(ctx.app.db, ids, {
    since: new Date(now - ASKS_WINDOW_DAYS * 86_400_000).toISOString(),
    until: new Date(now).toISOString(),
  });
  if (r.spent.runs === 0) return null;
  const apps = ctx.url.searchParams.get("apps");
  const href = `/board/returns${apps ? `?apps=${encodeURIComponent(apps)}` : ""}`;
  return html`<a class="board-asks" id="returns-line" href="${href}"
    >Tokens, ${ASKS_WINDOW_DAYS} days: <b>${usd(r.spent.usd)}</b> → <b>${r.landed}</b> landed
    · <b>${usd(r.onLanded.perChange.median)}</b> a landed change · <b>${usd(r.landedNothing.usd)}</b>
    landed nothing</a
  >`;
}

// ---- the planner, waiting for a person ----

/**
 * One line per app whose planner declined the direction: its last words
 * and a box to answer them, which is a comment on the direction issue —
 * the word `planIfThin` waits for. Only for apps whose owner facts the
 * viewer may see; nothing at all when no planner is waiting.
 */
function declinedStrip(ctx: Ctx, scope: BoardScope): Html | null {
  const declines = plannerDeclines(
    ctx.app.db,
    scope.repos.filter((r) => scope.ownerFacts.has(r.id)),
  );
  if (declines.length === 0) return null;
  return html`<div
    class="board-declined"
    id="declined"
    data-live="run.*,issue.*"
    role="status"
  >
    ${declines.map((d) => {
      const base = `/${d.repo.ownerName}/${d.repo.name}`;
      return html`<form
        class="board-declined-row"
        method="post"
        action="${base}/issues/${d.issue.number}/comments"
      >
        <span class="board-declined-says"
          ><b>${d.repo.name}</b>: the planner declined the direction and waits
          for you. <q>${d.words}</q></span
        >
        <input type="hidden" name="back" value="board" />
        <input
          class="input"
          name="body"
          required
          aria-label="Answer the planner on #${d.issue.number}"
          placeholder="Answer the planner"
        />
        <button class="btn" data-variant="primary" type="submit">Answer</button>
      </form>`;
    })}
  </div>`;
}

// ---- the subscriptions' windows ----

/** Figures in a row, `inferred` said once when every one is, else on each. */
function figures(parts: readonly FigureWords[]): Html {
  const all = parts.every((p) => p.inferred);
  const tag = html`<i class="board-inferred">inferred</i>`;
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
  const card = (s: Subscription): Html | null => {
    const st = all.get(s.id);
    if (st === undefined) return null;
    return html`<a
      class="board-sub"
      href="/settings/subscriptions"
      data-key="sub:${s.id}"
    >
      <span class="board-sub-name">${s.name}</span>
      ${st.windows.map((w) => {
        const words = windowWords(w);
        return html`<span class="board-window" data-window="${w.window}"
          ><span class="board-window-name">${words.name}</span>
          ${
            words.usedPct === null
              ? null
              : html`<span class="board-bar"
                  ><span class="board-fill" data-w="${words.usedPct}"></span
                ></span>`
          }
          <span class="board-window-nums"
            >${figures([words.used, words.remaining, words.resets])}${when(
              w.tokensIn + w.tokensOut > 0,
              () => html` · ${tokenCount(w.tokensIn + w.tokensOut, "counted")}`,
            )}</span
          ></span
        >`;
      })}
      ${when(
        scopeWords(s.id) !== "",
        () => html`<span class="board-sub-scope">for ${scopeWords(s.id)}</span>`,
      )}
    </a>`;
  };
  const crew = pool.filter((s) => s.id === PLATFORM || scopes.has(s.id));
  const apart = pool.filter((s) => s.id !== PLATFORM && !scopes.has(s.id));
  return html`<div
    class="board-windows"
    id="windows"
    data-live="run.*,usage.*"
    aria-label="Subscription windows"
  >
    <div class="board-subs" data-group="crew">
      <span class="board-group">The crew's</span>${crew.map(card)}
    </div>
    ${when(
      apart.length > 0,
      () =>
        html`<div class="board-subs" data-group="apart">
          <span class="board-group">Not offered to the crew</span>${apart.map(
            card,
          )}
        </div>`,
    )}
    <details class="board-spend-detail" id="spend-detail">
      <summary>Spend by credential, app, agent, issue and kind</summary>
      ${spendView(readSpend(ctx.app, now))}
    </details>
  </div>`;
}

// ---- working now ----

function working(ctx: Ctx, scope: BoardScope): Html {
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
  const rows = runs.map((run) => {
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
    const word = stateWord(run);
    return html`<li>
      <a
        class="board-card board-run"
        data-state="${word}"
        data-key="run:${run.id}"
        href="${repoBase(repo)}/runs/${run.id}"
      >
        ${avatar(who)}
        <span class="board-run-who"><b>${who}</b> · ${repo.name}</span>
        <span class="board-elapsed" data-started="${at(run)}"></span>
        <span class="board-run-title"
          >${issue?.title ?? (run.summary || "on the repository")}</span
        >
        <span class="board-run-meta">
          <span class="board-state">${word}</span>
          <span
            >${
              word === "paused" ? "resumes soon" : reasonWords(run.reason)
            }</span
          >
          ${when(
            run.costUsd > 0 && scope.ownerFacts.has(repo.id),
            () => html`<span class="num">${money(run.costUsd)}</span>`,
          )}
        </span>
      </a>
    </li>`;
  });
  return region(
    "working",
    "1",
    "Working now",
    "run.*",
    rows,
    scope.repos.length === 0
      ? "No apps to watch."
      : "Nobody is working right now.",
  );
}

// ---- landed ----

function landed(ctx: Ctx, scope: BoardScope): Html {
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
  const rows = pulls.map((pull: Pull) => {
    const repo = scope.byId.get(pull.repoId)!;
    const picture = pictureOf(repo);
    const author = voiceFor(
      { name: pull.authorName, isAgent: pull.authorIsAgent },
      scope.ownerFacts.has(repo.id),
    );
    const told = toldBy(db, pull);
    return html`<li>
      <a
        class="board-card board-landed"
        data-key="pull:${pull.id}"
        href="${repoBase(repo)}/pulls/${pull.number}"
      >
        <span class="board-thumb"
          >${
            picture === undefined
              ? icon("merge")
              : html`<img
                  src="${picture}"
                  width="34"
                  height="46"
                  alt=""
                  loading="lazy"
                />`
          }</span
        >
        <span class="board-landed-title">${pull.title}</span>
        <span class="board-when">${time(pull.mergedAt ?? pull.createdAt)}</span>
        <span class="board-landed-meta">${repo.name} · ${author}${told === null ? "" : html` · told by ${told}`}</span>
      </a>
    </li>`;
  });
  return region(
    "landed",
    "2",
    "Landed",
    "pull.merged,run.finished",
    rows,
    scope.repos.length === 0 ? "No apps to watch." : "Nothing has shipped yet.",
  );
}

// ---- decided ----

function decided(ctx: Ctx, scope: BoardScope): Html {
  const db = ctx.app.db;
  // The decision ledger is the owner's own record of what the crew chose —
  // never shown for a repository this viewer can only read.
  const ids = scope.repos
    .filter((r) => scope.ownerFacts.has(r.id))
    .map((r) => r.id);
  const decisions = listDecisionsForRepos(db, ids, 12);
  const about = getIssuesByIds(
    db,
    decisions.map((d) => d.issueId).filter((id): id is string => id !== null),
  );
  const rows = decisions.map((d: Decision) => {
    const repo = scope.byId.get(d.repoId)!;
    const base = repoBase(repo);
    // What the decision was about: the issue picked for `next`, the pull
    // for the rest. A pick names its issue by number.
    let issue: Issue | undefined =
      d.issueId === null ? undefined : about.get(d.issueId);
    if (d.kind === "next" && /^\d+$/.test(d.answer))
      issue = getIssue(db, repo.id, Number(d.answer)) ?? issue;
    const href =
      issue === undefined
        ? base
        : `${base}/${issue.kind === "pull" ? "pulls" : "issues"}/${issue.number}`;
    const answer =
      d.kind === "next" && issue !== undefined ? `#${issue.number}` : d.answer;
    return html`<li>
      <a
        class="board-card board-decision"
        data-key="decision:${d.id}"
        href="${href}"
        data-kind="${d.kind}"
      >
        <span class="board-kind">${KIND_WORDS[d.kind]}</span>
        <span class="board-decision-main">
          <span class="board-answer">${answer}</span>
          <span class="board-about"
            >${issue?.title ?? repo.name} ·
            ${d.by === "rule" ? "by the rule" : `by ${d.by}`}</span
          >
        </span>
        <span class="board-p" title="${Math.round(d.p * 100)}% sure">
          <span class="board-bar"
            ><span class="board-fill" data-w="${pct(d.p)}"></span
          ></span>
          <span class="num">${Math.round(d.p * 100)}%</span>
        </span>
        <span class="board-outcome" data-outcome="${d.outcome ?? ""}"
          >${d.outcome ?? "—"}</span
        >
        <span class="board-when">${time(d.createdAt)}</span>
      </a>
    </li>`;
  });
  return region(
    "decided",
    "3",
    "Decided",
    "run.*,pull.*",
    rows,
    "Nothing decided yet.",
  );
}

// ---- today ----

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
      const runs = listRuns(db, repo.id, { kind: "agent", limit: 200 }).filter(
        (r) => r.createdAt >= since,
      ).length;
      const shipped = listPulls(db, repo.id, {
        state: "closed",
        limit: 100,
      }).filter((p) => p.mergedAt !== null && p.mergedAt >= since).length;
      const share = s.ceilingUsd > 0 ? s.spentTodayUsd / s.ceilingUsd : 0;
      const review = reviewWords(reviewStats(db, repo.id, since));
      const note =
        s.paused === "ceiling"
          ? "at its ceiling until 00:00 UTC"
          : s.paused === "nobody"
            ? "nobody turned it on"
            : s.paused === "no crew"
              ? "no crew"
              : repo.autonomy;
      return html`<li>
        <a
          class="board-card board-app"
          data-key="app:${repo.ownerName}/${repo.name}"
          href="${repoBase(repo)}"
          ${s.paused === null ? null : html`data-paused="${s.paused}"`}
        >
          <span class="board-app-name"
            >${repo.name} <span class="board-app-mode">${note}</span></span
          >
          <span class="board-app-nums">
            <span
              ><b>${money(s.spentTodayUsd)}</b> of
              $${s.ceilingUsd.toFixed(0)}</span
            >
            <span><b>${runs}</b> run${runs === 1 ? "" : "s"}</span>
            <span><b>${shipped}</b> shipped</span>
          </span>
          <span class="board-app-week"
            >${perShippedWords(week.get(repo.id))} this week</span
          >
          ${when(
            review !== null,
            () => html`<span class="board-app-week board-app-review"
              >${review}</span
            >`,
          )}
          <span class="board-spend"
            ><span class="board-fill" data-w="${pct(share)}"></span
          ></span>
        </a>
      </li>`;
    });
  return region(
    "today",
    "4",
    "Today",
    "run.*,pull.merged",
    rows,
    scope.repos.length === 0
      ? "No apps to watch."
      : "No app runs on its own yet.",
  );
}

// ---- style ----

/** Width rules for the bars: a whole percentage as `data-w`, since an inline style is not allowed. */
const widths = Array.from(
  { length: 101 },
  (_, n) => `.board-fill[data-w="${n}"] { width: ${n}%; }`,
).join("\n");

/**
 * The board's own components, assembled into the served stylesheet by
 * `web/style.ts` rather than sent inline with the page. Every rule here is
 * a `.board-*` selector nothing else in the sheet mentions, so the
 * `components` layer is where they read the same as they always did.
 */
export const boardCss = /* css */ `
@layer components {
.board { --pad: clamp(16px, 2.2vw, 32px); display: flex; flex-direction: column; min-height: 100dvh; font-size: 16px; }
.board-top { display: flex; align-items: center; gap: 14px; padding: 14px var(--pad) 0; color: var(--faint); font-size: 13px; }
.board-brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; letter-spacing: -0.03em; font-size: 15px; color: var(--muted-fg); }
.board-brand:hover { color: var(--fg); }
.board-brand .mark { width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(135deg, var(--accent), var(--merged)); }
.board-scope { color: var(--faint); }
.board-keys { display: none; align-items: center; gap: 6px; }
.board-keys kbd { height: 18px; min-width: 18px; font-size: 10.5px; }
.board-live { display: inline-flex; align-items: center; }
.board-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--faint); transition: background-color 200ms var(--ease), box-shadow 200ms var(--ease); }
.board-live[data-state="open"] .board-dot { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent); }
.board-live[data-state="reconnecting"] .board-dot { background: var(--attn); }
.board-clock { font-family: var(--mono); font-size: 13px; font-variant-numeric: tabular-nums; color: var(--muted-fg); min-width: 5ch; text-align: right; }
.board-asked { font-size: 13px; color: var(--muted-fg); text-decoration: none; }
.board-asked:hover { color: var(--fg); }
.board-forge { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; min-height: 28px; padding: 6px var(--pad) 0; font-size: 13px; color: var(--faint); }
.board-forge[data-ok="no"] { color: var(--attn); }
.board-asks { display: block; padding: 6px var(--pad) 0; font-size: 13px; color: var(--faint); text-decoration: none; }
.board-asks b { color: var(--fg); font-weight: 600; }
.board-declined { display: flex; flex-direction: column; gap: 8px; padding: 10px var(--pad) 0; }
.board-declined-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(12em, 22em) auto; gap: 10px; align-items: center; padding: 10px 14px; border: 1px solid color-mix(in srgb, var(--attn) 45%, var(--border)); border-radius: var(--radius, 10px); }
.board-declined-says { color: var(--attn); line-height: 1.35; }
.board-declined-says q { color: var(--fg); }
.board[data-wall] .board-declined-row .input, .board[data-wall] .board-declined-row .btn { display: none; }
a.board-forge-need { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
.board-grid { flex: 1; display: grid; gap: var(--pad); padding: 12px var(--pad) var(--pad); min-height: 0; }
.board-region { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.board-h {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px;
  margin: 0; padding: 4px 0 12px; background: var(--bg);
  font-size: 12.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted-fg);
}
.board-key { font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0; color: var(--faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; line-height: 16px; }
.board-count { color: var(--faint); font-weight: 500; letter-spacing: 0; font-variant-numeric: tabular-nums; }
.board-region[data-fresh] .board-h { color: var(--accent); }
.board-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.board-quiet { margin: 2px 0 0; color: var(--faint); font-size: 1em; }
.board-card {
  display: grid; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--card); color: inherit; transition: border-color 140ms var(--ease);
}
.board-card:hover { border-color: var(--border-strong); color: inherit; }
.board-when { color: var(--faint); font-size: .875em; font-variant-numeric: tabular-nums; white-space: nowrap; }
.board-bar { display: block; height: 5px; border-radius: 999px; background: var(--muted); overflow: hidden; }
.board-fill { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 400ms var(--ease); }
${widths}

/* Working now: the crew member and app, what it is on, why, and the clock. */
.board-run { grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 12px; align-items: start; padding: 14px 16px; }
.board-run .avatar { grid-row: 1 / span 3; width: 36px; height: 36px; font-size: 14px; margin-top: 3px; }
.board-run-who { font-size: .9em; color: var(--muted-fg); }
.board-run-who b { color: var(--fg); font-weight: 600; }
.board-elapsed { grid-column: 3; grid-row: 1 / span 2; font-family: var(--mono); font-size: 1.5em; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; line-height: 1.2; min-width: 4ch; text-align: right; }
.board-run-title { grid-column: 2; font-size: 1.2em; font-weight: 550; line-height: 1.3; letter-spacing: -0.01em; text-wrap: pretty; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.board-run-meta { grid-column: 2 / span 2; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; font-size: .9em; color: var(--muted-fg); }
.board-state { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--fg); }
.board-state::before { content: ""; width: 8px; height: 8px; border-radius: 999px; background: var(--faint); }
.board-run[data-state="working"] { border-color: color-mix(in srgb, var(--accent) 38%, var(--border)); }
.board-run[data-state="working"] .board-state { color: var(--accent); }
.board-run[data-state="working"] .board-state::before { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.board-run[data-state="working"] .board-elapsed { color: var(--accent); }
.board-run[data-state="queued"] .board-elapsed { color: var(--muted-fg); }
.board-run[data-state="paused"] .board-state { color: var(--attn); }
.board-run[data-state="paused"] .board-state::before { background: var(--attn); }
/* Nothing on the wall animates on its own. A perpetual animation keeps the
   browser painting every frame all day — three pulsing dots measured at over
   100% CPU under software rendering. The ticking clocks are the sign of life. */

/* Landed: the production look on a phone, the change, who, when. */
.board-landed { grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 14px; align-items: center; padding: 10px 14px; }
.board-thumb { grid-row: 1 / span 2; display: flex; align-items: center; justify-content: center; width: 34px; height: 46px; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; background: var(--muted); color: var(--merged); }
.board-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
.board-landed-title { font-size: 1.05em; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-landed-meta { grid-column: 2; font-size: .875em; color: var(--muted-fg); }
.board-landed .board-when { grid-column: 3; grid-row: 1 / span 2; }

/* Decided: the kind, the answer, how sure, what came of it. */
.board-decision { grid-template-columns: 6.5em minmax(0, 1fr) 7em 4.5em auto; gap: 12px; align-items: center; padding: 10px 14px; }
.board-kind { font-size: .75em; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted-fg); }
.board-decision-main { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.board-answer { font-size: 1.05em; font-weight: 600; }
.board-about { font-size: .875em; color: var(--muted-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-p { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: .75em; color: var(--muted-fg); }
.board-p .board-bar { flex: 1; }
.board-outcome { font-size: .875em; color: var(--faint); }
.board-outcome[data-outcome="shipped"], .board-outcome[data-outcome="green"] { color: var(--success); }
.board-outcome[data-outcome="red"] { color: var(--danger); }
.board-outcome[data-outcome="shown"], .board-outcome[data-outcome="closed"] { color: var(--attn); }

/* Today: each app that runs on its own, its spend against the ceiling. */
.board-app { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 14px; align-items: baseline; padding: 12px 16px; }
.board-app-name { font-size: 1.1em; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-app-mode { font-size: .8em; font-weight: 500; color: var(--muted-fg); margin-left: 4px; }
.board-app[data-paused] .board-app-mode { color: var(--attn); }
.board-app-nums { display: flex; gap: 14px; font-size: .875em; color: var(--muted-fg); font-variant-numeric: tabular-nums; white-space: nowrap; }
.board-app-nums b { color: var(--fg); font-weight: 600; }
.board-spend { grid-column: 1 / -1; display: block; height: 6px; border-radius: 999px; background: var(--muted); overflow: hidden; }
.board-app[data-paused="ceiling"] .board-fill { background: var(--attn); }

/* Windows: each subscription's 5-hour and weekly window, admin only. */
.board-windows { display: flex; flex-wrap: wrap; gap: 8px 12px; padding: 8px var(--pad) 0; font-size: 13px; }
.board-sub { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); color: var(--muted-fg); }
.board-sub:hover { border-color: var(--border-strong); color: var(--muted-fg); }
.board-sub-name { font-weight: 600; color: var(--fg); }
.board-subs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.board-group { font-size: .85em; color: var(--faint); text-transform: uppercase; letter-spacing: .04em; }
.board-subs[data-group="apart"] .board-sub { border-style: dashed; }
.board-sub-scope { color: var(--faint); }
.board-spend-detail { flex-basis: 100%; }
.board-spend-detail summary { cursor: pointer; color: var(--muted-fg); }
.spend-table { margin-top: 8px; }
.spend-table caption { text-align: left; color: var(--muted-fg); }
.spend-totals { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 0; }
.board-window { display: inline-flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; }
.board-window-name { color: var(--faint); }
.board-window .board-bar { width: 56px; }
.board-window[data-window] .board-fill[data-w="100"] { background: var(--attn); }
.board-inferred { font-style: normal; font-size: .85em; color: var(--faint); border: 1px dashed var(--border); border-radius: 4px; padding: 0 4px; }
.board-app-week { grid-column: 1 / -1; font-size: .875em; color: var(--muted-fg); font-variant-numeric: tabular-nums; }

/* Wide: four regions fill the window, each scrolling on its own. */
@media (min-width: 1100px) {
  .board { flex: none; height: 100dvh; min-height: 0; }
  .board-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
  .board-region { overflow: auto; scrollbar-width: thin; scrollbar-color: var(--border) transparent; padding-right: 2px; }
  .board-keys { display: inline-flex; }
  .board[data-focus] .board-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .board[data-focus] { font-size: 19px; }
}
@media (min-width: 1600px) { .board { font-size: 17px; } .board[data-focus] { font-size: 21px; } }
/* Narrow: stacked, and the decision row folds. */
@media (max-width: 719px) {
  .board-elapsed { font-size: 1.05em; }
  .board-run-title { -webkit-line-clamp: 3; }
  .board-landed-title { white-space: normal; text-wrap: pretty; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .board-app { grid-template-columns: minmax(0, 1fr); }
  .board-app-name { white-space: normal; }
  .board-decision { grid-template-columns: minmax(0, 1fr) auto; }
  .board-kind { grid-column: 1 / -1; }
  .board-p { grid-column: 1; }
  .board-outcome { grid-column: 2; grid-row: 2; }
  .board-decision .board-when { grid-column: 2; grid-row: 3; }
  .board-app-nums { flex-wrap: wrap; white-space: normal; gap: 6px 12px; }
  .board-scope { display: none; }
  .board-declined-row { grid-template-columns: minmax(0, 1fr) auto; }
  .board-declined-says { grid-column: 1 / -1; }
}
/* One region, full bleed. */
.board[data-focus] .board-region { display: none; }
/* The wall mode: read from across the room, and nobody at the keys. */
.board[data-wall] { font-size: 20px; cursor: none; }
.board[data-wall] .board-keys { display: none; }
@media (min-width: 1600px) { .board[data-wall] { font-size: 23px; } }
.board[data-focus="working"] #working, .board[data-focus="landed"] #landed,
.board[data-focus="decided"] #decided, .board[data-focus="today"] #today { display: flex; }
}
`;
