/**
 * The studio's vocabulary: the five words (and the four that only ever fold
 * into them — `waiting`, `planned` into `working`, `done` into `shipped`,
 * `cancelled` into `stopped`) a person reads on every studio page, and the
 * badge that draws one. `runWord` and `pullWord` are the one place a word is
 * decided, from facts in git and the tables — never from a run's own summary
 * text — so the home, the app, a change, a tell and every list say the same
 * thing about the same commit. Nothing here knows about a page.
 */

import { crewFace } from "../pixel.ts";
import { shownState } from "../../runs/state.ts";
import type { Database } from "bun:sqlite";
import { ancestries, type AncestryCache } from "./ancestry.ts";
import {
  NO_TESTS_TAIL,
  TESTS_PASSED_TAIL,
  type AppsRuntime,
  type EnvStatus,
} from "../../apps/runtime.ts";
import type { AppRecord } from "../../core/apps.ts";
import { canEnterApp, getRepoById, type Repo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import type { WindowStanding } from "../../core/standing.ts";
import { whenText } from "../../crew/limits.ts";
import { pausedNote } from "../../crew/pacing.ts";
import { reviewWaitsFor, waitsForReviewer } from "../../crew/review.ts";
import { getIssueById, getIssuesByIds } from "../../core/issues.ts";
import {
  getPull,
  joinMany,
  pullForBranch,
  pullsForBranches,
  type Pull,
} from "../../core/pulls.ts";
import {
  checkSummary,
  checksForHeads,
  STOPPED_SUMMARY,
  type CheckDetail,
  type CheckSummary,
  type Run,
} from "../../core/runs.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../ui.ts";
import type { Paused } from "../../crew/autonomy.ts";

/**
 * The empty crew, said once: the shelf's stuck tell, the app page's autonomy
 * card and the settings card all take it from here.
 */
export const NOBODY_ON_CREW = "nobody on the crew";

/** The quiet line under a mode nothing can honour yet. `href` is the crew panel. */
export function noCrewLine(href: string): Html {
  return html`<p class="muted small">
    Mode is a promise with ${NOBODY_ON_CREW} to keep it.
    <a href="${href}">Put someone on the crew</a>.
  </p>`;
}

export type Word =
  | "working"
  | "look"
  | "shipped"
  | "stopped"
  | "waiting"
  | "planned"
  | "told"
  | "done"
  | "cancelled"
  | "silent"
  | "needs input";

/**
 * Production's history as one page has asked it: the ancestry of each
 * distinct (git directory, production commit) it met, read from git once
 * and shared by every row after — a page of N merged changes is one spawn
 * per repository, not N. Made fresh for each render (`servingHistory`) and
 * dropped with it, so a deploy that lands is seen on the very next page.
 */
export type ServingHistory = Map<
  string,
  Promise<ReadonlySet<string> | undefined>
>;

/** An empty memo for one page's render. */
export function servingHistory(): ServingHistory {
  return new Map();
}

/**
 * Everything the word functions below need to see production: the repo's
 * git directory (an ancestry check reads it), the runtime plus the app
 * record, when the repository runs one, and the page's memo of what
 * production's history holds. Built once per page and threaded through —
 * never a second way to ask what is serving.
 */
export interface WordCtx {
  readonly db: Database;
  readonly dir: string;
  readonly runtime: AppsRuntime | undefined;
  readonly record: AppRecord | undefined;
  readonly history: ServingHistory;
  /** Who is reading: a private app's production is theirs only if they may enter it. */
  readonly viewer: User | undefined;
  /** Where ancestries are kept; the process's own unless a test brings its own. */
  readonly ancestries?: AncestryCache;
}

/** What a page read ahead for its rows, so `pullWord` and `runWord` do not read per row. */
interface Ahead {
  readonly checks: Map<string, CheckSummary>;
  readonly reviewers: Map<string, string | undefined>;
  readonly runPulls: Map<string, Pull | undefined>;
  readonly parked: Map<string, boolean>;
  /** Production as a merged pull sees it; `null` when the viewer may not see it. */
  production?: { env: EnvStatus | undefined } | null;
}
// Keyed by the page's `WordCtx`, which is made fresh for each request and
// dropped with it, so nothing here outlives the render it was read for.
const ahead = new WeakMap<WordCtx, Ahead>();
const aheadOf = (ctx: WordCtx): Ahead => {
  let a = ahead.get(ctx);
  if (a === undefined)
    ahead.set(ctx, (a = { checks: new Map(), reviewers: new Map(), runPulls: new Map(), parked: new Map() }));
  return a;
};

/**
 * Read, for all these pulls at once, what `pullWord` asks per open pull: its
 * check at its head, and the reviewer a green agent pull waits for. The
 * words that follow are the ones a read apiece gives, in a handful of queries.
 */
export function knowPulls(ctx: WordCtx, pulls: readonly Pull[]): void {
  const a = aheadOf(ctx);
  const open = pulls.filter(
    (p) => p.mergedAt === null && p.state !== "closed" && !a.checks.has(p.id),
  );
  if (open.length === 0) return;
  const runs = checksForHeads(ctx.db, new Map(open.map((p) => [p.id, p.headOid])));
  const green: Pull[] = [];
  for (const p of open) {
    const latest = runs.get(p.id)?.[0];
    a.checks.set(
      p.id,
      latest ? { state: latest.state, run: latest } : { state: "none", run: null },
    );
    if (latest?.state === "ok") green.push(p);
  }
  const repos = new Map<string, Repo | undefined>();
  for (const p of green)
    if (!repos.has(p.repoId)) repos.set(p.repoId, getRepoById(ctx.db, p.repoId));
  const have = green.flatMap((pull) => {
    const repo = repos.get(pull.repoId);
    return repo ? [{ repo, pull }] : [];
  });
  const waits = reviewWaitsFor(ctx.db, have);
  for (const p of green) a.reviewers.set(p.id, waits.get(p.id)?.reviewer);
}

/**
 * `pullWord` for a page of pulls: checks, reviewers, close reasons and
 * production's status are read together first, so the page costs a handful
 * of queries rather than several per row. Each word is the one `pullWord`
 * gives, in the order of `pulls`.
 */
export async function pullWords(
  ctx: WordCtx,
  pulls: readonly Pull[],
): Promise<{ word: Word; note: string }[]> {
  knowPulls(ctx, pulls);
  const a = aheadOf(ctx);
  const closed = pulls.filter((p) => p.mergedAt === null && p.state === "closed");
  if (closed.length > 0) {
    const issues = getIssuesByIds(ctx.db, closed.map((p) => p.id));
    for (const p of closed)
      a.parked.set(p.id, issues.get(p.id)?.closeReason === "parked");
  }
  if (
    a.production === undefined &&
    pulls.some((p) => p.mergedAt !== null) &&
    ctx.runtime !== undefined &&
    ctx.record !== undefined
  ) {
    const repo = getRepoById(ctx.db, ctx.record.repoId);
    a.production =
      repo === undefined ||
      !canEnterApp(ctx.db, repo, ctx.record, ctx.viewer, { named: false })
        ? null
        : {
            env: ctx.runtime
              .status(ctx.record)
              .find((e) => e.env === "production"),
          };
  }
  return await Promise.all(pulls.map((p) => pullWord(ctx, p)));
}

/** `knowPulls` for the pull each of these finished runs produced (`pullFromRun`). */
export function knowRunPulls(ctx: WordCtx, runs: readonly Run[]): void {
  const a = aheadOf(ctx);
  const want = runs.filter((r) => !a.runPulls.has(r.id));
  if (want.length === 0) return;
  const about = getIssuesByIds(
    ctx.db,
    want.flatMap((r) => (r.issueId === null ? [] : [r.issueId])),
  );
  const direct = new Map(
    joinMany(ctx.db, [...about.values()].filter((i) => i.kind === "pull")).map(
      (p) => [p.id, p] as const,
    ),
  );
  const byBranch = new Map<string, Map<string, Pull>>();
  for (const repoId of new Set(want.map((r) => r.repoId)))
    byBranch.set(
      repoId,
      pullsForBranches(
        ctx.db,
        repoId,
        want.filter((r) => r.repoId === repoId).map((r) => r.branch),
      ),
    );
  const found: Pull[] = [];
  for (const r of want) {
    const pull =
      (r.issueId === null ? undefined : direct.get(r.issueId)) ??
      (r.branch === "" ? undefined : byBranch.get(r.repoId)?.get(r.branch));
    a.runPulls.set(r.id, pull);
    if (pull !== undefined) found.push(pull);
  }
  knowPulls(ctx, found);
}

/**
 * The pull an agent run produced, if it produced one — not a foreign key
 * (a pull is its own issue, unrelated in the schema to the issue it
 * closes) but the two facts a run leaves behind: a review run's
 * `issueId` is the pull itself, and a builder run's `branch` is the one
 * `landWork` (`crew/runner.ts`) already uses to find its own pull again.
 */
function pullFromRun(db: Database, run: Run): Pull | undefined {
  if (run.issueId !== null) {
    const about = getIssueById(db, run.issueId);
    if (about?.kind === "pull") return getPull(db, run.repoId, about.number);
  }
  if (run.branch === "") return undefined;
  return pullForBranch(db, run.repoId, run.branch);
}

/** Whether production is serving this commit, or something later than it:
 * ancestry, never equality, asked of git once per page and repository. */
async function caughtUp(
  ctx: WordCtx,
  production: EnvStatus | undefined,
  commitOid: string,
): Promise<boolean> {
  if (production === undefined || production.commitOid === "") return false;
  if (production.commitOid === commitOid) return true;
  const key = `${ctx.dir}\0${production.commitOid}`;
  let ancestry = ctx.history.get(key);
  if (ancestry === undefined) {
    ancestry = (ctx.ancestries ?? ancestries).of(ctx.dir, production.commitOid);
    ctx.history.set(key, ancestry);
  }
  return (await ancestry)?.has(commitOid) ?? false;
}

/** A merged pull production has not caught up to yet: its own honest word. */
function mergedPullWord(
  production: EnvStatus | undefined,
  commitOid: string,
): { word: Word; note: string } {
  if (production?.commitOid === commitOid) {
    if (production.state === "failed")
      return {
        word: "stopped",
        note: production.error ?? "production's deploy of it failed",
      };
    return { word: "working", note: "production is deploying it now" };
  }
  return { word: "waiting", note: "merged; waiting for production to redeploy" };
}

/**
 * What failed, in a sentence: the counts `parseBunTestFailure` already
 * recognised, stored with the run — never re-read from its log here — and
 * the first few names it kept, escaped as text like any other value
 * (`html`, `web/html.ts`) wherever this lands on a page.
 */
function detailNote(detail: CheckDetail): string {
  const more = detail.failed - detail.names.length;
  const names = detail.names.join(", ") + (more > 0 ? `, and ${more} more` : "");
  return `${detail.passed} passed, ${detail.failed} failed: ${names}`;
}

/**
 * What a green deploy says about its tests, from the summary the runtime
 * wrote when it finished: the one clause every surface that draws a green
 * change uses. Empty for a run that predates the clause.
 */
export function testsClause(run: Run | null): string {
  const summary = run?.summary ?? "";
  if (summary.endsWith(TESTS_PASSED_TAIL)) return "its tests passed";
  if (summary.endsWith(NO_TESTS_TAIL)) return "it answered, no tests were run";
  return "";
}

/** A single open pull's check, in the studio's own words — never dev's
 * "Checks passed/failed": the same five words as the rest of the page. */
function checkRunWord(check: CheckSummary): { word: Word; note: string } {
  if (check.state === "ok") {
    const clause = testsClause(check.run);
    return {
      word: "look",
      note: `green — ${clause === "" ? "" : `${clause}, `}ready for a look`,
    };
  }
  if (check.state === "failed") {
    const base =
      check.run?.servingAt != null
        ? "serving, but the check failed"
        : "failed before it answered";
    const detail = check.run?.checkDetail;
    return {
      word: "stopped",
      note: detail && detail.names.length > 0 ? `${base} — ${detailNote(detail)}` : base,
    };
  }
  if (check.state === "running")
    return {
      word: "working",
      note: check.run?.servingAt != null ? "serving — still checking" : "checking now",
    };
  if (check.state === "queued")
    return { word: "working", note: "queued to check" };
  if (check.state === "cancelled")
    return { word: "stopped", note: "the check was cancelled" };
  return { word: "waiting", note: "no deploy of this head yet" };
}

/**
 * A pull's word: open goes by its own check, closed without a merge is
 * simply stopped, and merged is *shipped* only once production is at or
 * past the commit that merge carried — the one place that fact is asked,
 * so the app page, the change page, the home and the board never invent
 * their own answer to it.
 */
export async function pullWord(
  ctx: WordCtx,
  pull: Pull,
): Promise<{ word: Word; note: string }> {
  if (pull.mergedAt !== null) {
    const commitOid = pull.mergedOid ?? pull.headOid;
    if (ctx.runtime === undefined || ctx.record === undefined)
      return { word: "shipped", note: "merged" };
    // A private app's production — its state, its deploy's error — is for
    // those who may enter it (`canEnterApp`); anyone else reads "merged".
    const read = ahead.get(ctx)?.production;
    if (read === null) return { word: "shipped", note: "merged" };
    let production: EnvStatus | undefined;
    if (read !== undefined) production = read.env;
    else {
      const repo = getRepoById(ctx.db, ctx.record.repoId);
      if (
        repo === undefined ||
        !canEnterApp(ctx.db, repo, ctx.record, ctx.viewer, { named: false })
      )
        return { word: "shipped", note: "merged" };
      production = ctx.runtime
        .status(ctx.record)
        .find((e) => e.env === "production");
    }
    if (await caughtUp(ctx, production, commitOid))
      return { word: "shipped", note: "production is serving it" };
    return mergedPullWord(production, commitOid);
  }
  if (pull.state === "closed")
    return {
      word: "stopped",
      note:
        (ahead.get(ctx)?.parked.get(pull.id) ??
          getIssueById(ctx.db, pull.id)?.closeReason === "parked")
          ? "parked by the crew"
          : "closed without shipping",
    };
  const check =
    ahead.get(ctx)?.checks.get(pull.id) ??
    checkSummary(ctx.db, pull.id, pull.headOid);
  // A repository that is not an app never deploys a head, so it never gets
  // a look: an open change there waits on a person, and says so.
  if (ctx.record === undefined && check.state === "none")
    return { word: "waiting", note: "open — waiting on a person" };
  if (check.state === "ok") {
    const known = ahead.get(ctx)?.reviewers;
    const reviewer = known?.has(pull.id)
      ? known.get(pull.id)
      : waitsForReviewer(ctx.db, pull.repoId, pull);
    if (reviewer !== undefined)
      return { word: "waiting", note: `waiting for ${reviewer}'s review` };
  }
  return checkRunWord(check);
}

/**
 * A run's word: still going by its state, and once it is over, by what it
 * produced. A pull, when there is one, is judged the same way `pullWord`
 * judges any other. Short of that, an agent run that shipped nothing is
 * *planned* rather than a guess at *shipped* — but a deploy or a check
 * never produces a pull of its own, so the same absence there just means
 * it finished: *done*, not *planned*. Never `run.summary`: that stays the
 * note beside the word.
 */
export async function runWord(
  ctx: WordCtx,
  run: Run,
): Promise<{ word: Word; note: string }> {
  if (run.state === "queued")
    return run.notBefore === null
      ? { word: "waiting", note: "queued" }
      : { word: "waiting", note: pausedNote(run.notBefore) };
  if (run.state === "running") {
    // Worked out from what the run did, never what it says (`runs/state.ts`).
    const shown = shownState(ctx.db, run);
    if (shown === "silent") return { word: "silent", note: "no sign of life" };
    if (shown === "needs input") return { word: "needs input", note: "waiting on a person" };
    return { word: "working", note: "now" };
  }
  if (run.state === "failed")
    return { word: "stopped", note: run.summary || run.state };
  // A cancelled run is not a broken one — superseded by a newer push, its
  // environment torn down, a person's own Cancel, or the runtime itself
  // stopping (`STOPPED_SUMMARY`, the one summary that earns a friendlier
  // note than the raw fact, the same way it already reads on the run's own
  // log). The word is always the quiet one; only the note still comes from
  // the summary, exactly as every other word's note already does.
  if (run.state === "cancelled")
    return {
      word: "cancelled",
      note:
        run.summary === STOPPED_SUMMARY
          ? "interrupted by a restart"
          : run.summary || run.state,
    };
  const known = ahead.get(ctx)?.runPulls;
  const pull = known?.has(run.id) ? known.get(run.id) : pullFromRun(ctx.db, run);
  if (pull !== undefined) return await pullWord(ctx, pull);
  if (run.kind !== "agent")
    return {
      word: "done",
      note: run.summary || (run.kind === "deploy" ? "deployed" : "checked"),
    };
  return { word: "planned", note: run.summary || "nothing to show yet" };
}

/**
 * How long a production deploy stays news on the shelf and the front door's
 * rail, once nothing has happened since: long enough to survive a coffee
 * break after shipping, short enough that a deploy from last week does not
 * crowd out *quiet* as the invitation to tell the crew something. A run in
 * flight or an open change is never bounded this way — only the one fact
 * here that has no other way to expire.
 */
export const DEPLOY_NEWS_MS = 24 * 60 * 60_000;

/** The one production fact worth telling beside a run or a change: a deploy
 * that just landed, or one that just failed. */
export interface ProductionFact {
  readonly word: Extract<Word, "shipped" | "stopped">;
  readonly note: string;
  readonly actorId: string | null;
  /** The deploy run this fact is about — a link to its log. */
  readonly runId: string;
  /** The instant to sort and print this fact by. */
  readonly at: string;
}

/**
 * The rule the front door's *happening* half follows for a deploy, decided
 * once so the next case (a stalled deploy, a rollback) rebases on this
 * rather than growing a fifth special case: production's own status names
 * two candidate facts — the deploy now serving, and, when a newer one was
 * attempted and failed behind it, that failure (#200's case) — and this
 * picks whichever is news, preferring the failure when both are and the
 * failure is not older. Neither counts once `DEPLOY_NEWS_MS` has passed
 * without anything newer.
 *
 * A deploy no push asked for — a redeploy someone pressed, the boot
 * reconcile every restart runs — carries no `createdAt` (`apps/runtime.ts`'s
 * `PUSH_REASONS`), so it is never news: a person would not call it one, and
 * without this the front door would read *shipped* after every restart.
 *
 * `runs` is the batch lookup of whatever run ids `production` names, read
 * once for the whole shelf by the caller — never a query here.
 */
export function productionFact(
  production: EnvStatus | undefined,
  runs: ReadonlyMap<string, Run>,
  now = Date.now(),
): ProductionFact | undefined {
  if (production === undefined) return undefined;
  const news = (at: string | undefined): at is string =>
    at !== undefined && now - Date.parse(at) <= DEPLOY_NEWS_MS;

  const failedRun =
    production.failedDeploy === undefined
      ? undefined
      : runs.get(production.failedDeploy.runId);
  const failedAt = failedRun?.finishedAt ?? failedRun?.createdAt;
  const failed: ProductionFact | undefined =
    production.failedDeploy !== undefined && failedRun !== undefined && news(failedAt)
      ? {
          word: "stopped",
          note: `${production.failedDeploy.commitOid.slice(0, 7)} did not come up — ${production.failedDeploy.error}`,
          actorId: failedRun.actorId,
          runId: failedRun.id,
          at: failedAt!,
        }
      : undefined;

  const shippedAt = production.servingAt ?? production.createdAt;
  const shipped: ProductionFact | undefined =
    production.state === "running" &&
    production.createdAt !== undefined &&
    production.runId !== undefined &&
    news(shippedAt)
      ? {
          word: "shipped",
          note: `production is serving ${production.commitOid.slice(0, 7)}`,
          actorId: runs.get(production.runId)?.actorId ?? null,
          runId: production.runId,
          at: shippedAt!,
        }
      : undefined;

  if (failed !== undefined && shipped !== undefined)
    return failed.at >= shipped.at ? failed : shipped;
  return failed ?? shipped;
}

/** The colour a word is drawn in. */
export type WordVariant = "success" | "danger" | "accent" | "secondary";

/**
 * Each word's colour, decided once: the badge draws it and the board
 * colours its cards by it, so a word added to `Word` cannot render
 * uncoloured anywhere — the `Record` will not compile without it.
 * `cancelled` draws the same quiet, secondary look as `waiting` and
 * `planned` — a restart is never the danger red a real failure earns.
 */
const WORD_VARIANT: Record<Word, WordVariant> = {
  working: "accent",
  look: "success",
  shipped: "success",
  stopped: "danger",
  waiting: "secondary",
  planned: "secondary",
  told: "secondary",
  done: "success",
  cancelled: "secondary",
  silent: "danger",
  "needs input": "secondary",
};

export const wordVariant = (word: Word): WordVariant => WORD_VARIANT[word];

/** One of the five (or six) studio words, as a badge. An id names the one a
 * live script repaints as a run finishes (`studioRunJs`). */
export function wordBadge(word: Word, id?: string, who?: string): Html {
  return html`<span
    class="badge"
    data-variant="${wordVariant(word)}"
    data-word="${word}"
    ${id === undefined ? null : html`id="${id}"`}
    >${word === "working" ? ((who !== undefined && crewFace(who, "working", 16, true)) || icon("loader")) : null}${word === "told"
      ? "open"
      : word}</span
  >`;
}

/** Why an app that runs on its own is not running right now, in words —
 * the app page's *On its own* card and the board's *Today* row both. */
export function pausedWords(paused: Paused): string {
  switch (paused) {
    case "ceiling":
      return "at the ceiling, until 00:00 UTC";
    case "forge ceiling":
      return "at the forge's ceiling, until 00:00 UTC";
    case "nobody":
      return "nobody turned it on";
    case "no crew":
      return "no crew";
  }
}

/** A word at rest: one small coloured dot, the word (and its note) for a
 * screen reader. Colour alone is not a mark, so a state that needs someone
 * (`wordNeedsText`) is also written beside the row (see `wordText`). */
export function wordNeedsText(word: Word): boolean {
  return word === "working" || word === "look" || word === "stopped";
}

/** The visible word for a state that needs someone; nothing for the rest. */
export function wordText(word: Word): Html | null {
  return wordNeedsText(word)
    ? html`<span class="word-text" data-word="${word}">${word}</span> · `
    : null;
}

export function wordDot(word: Word, note?: string): Html {
  const tone =
    word === "look" || word === "shipped" || word === "done"
      ? "success"
      : word === "stopped"
        ? "danger"
        : word === "working"
          ? "attn"
          : "none";
  const said = `${word === "told" ? "open" : word}${note ? ` — ${note}` : ""}`;
  return html`<span class="dot" data-tone="${tone}" data-word="${word}" role="img" aria-label="${said}"></span>`;
}

/** A pull's own state at rest: the dot, its word for a screen reader. */
export function stateDot(state: "open" | "closed" | "merged", parked = false): Html {
  const said = state === "closed" && parked ? "parked" : state;
  const tone = state === "open" ? "success" : state === "merged" ? "merged" : "none";
  // Open is the quiet state; a settled one is written out beside its dot.
  return html`<span class="dot" data-state="${state}" data-tone="${tone}" role="img" aria-label="${said}"></span>${
    state === "open" ? null : html`<span class="word-text">${said === "merged" ? "Merged" : said === "parked" ? "Parked" : "Closed"}</span>`
  }`;
}

// ---- what a subscription has left, and what a change costs ----

/** One figure as a person reads it, and whether the forge worked it out
 * (from the usage ledger) rather than the provider saying it. */
export interface FigureWords {
  readonly text: string;
  readonly inferred: boolean;
}

/** A subscription's window (`core/standing.ts`) in words: what is used,
 * what is left, when it resets. Money in US dollars of list price. */
export interface WindowWords {
  readonly name: string;
  readonly used: FigureWords;
  readonly remaining: FigureWords;
  readonly resets: FigureWords;
  /** Whole percent of the cap used, 0–100; null while no cap is known. */
  readonly usedPct: number | null;
}

const dollars = (n: number): string => `$${n.toFixed(2)}`;

export function windowWords(w: WindowStanding): WindowWords {
  const full = w.remaining?.source === "read" && w.remaining.value === 0;
  const usedPct = full
    ? 100
    : w.cap === null || w.cap.value <= 0
      ? null
      : Math.max(0, Math.min(100, Math.round((w.used.value / w.cap.value) * 100)));
  return {
    name: w.window === "5h" ? "5-hour window" : "weekly window",
    used: {
      text: `${dollars(w.used.value)} used`,
      inferred: w.used.source === "inferred",
    },
    remaining:
      w.remaining === null
        ? { text: "cap not known yet", inferred: false }
        : full
          ? { text: "full", inferred: false }
          : {
              text: `${dollars(w.remaining.value)} left`,
              inferred: w.remaining.source === "inferred",
            },
    resets:
      w.resetsAt === null
        ? { text: "opens on next use", inferred: false }
        : {
            text: `resets ${whenText(new Date(w.resetsAt.value))}`,
            inferred: w.resetsAt.source === "inferred",
          },
    usedPct,
  };
}
