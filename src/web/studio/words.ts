/**
 * The studio's vocabulary: the five words (and the four that only ever fold
 * into them — `waiting`, `planned` into `working`, `done` into `shipped`,
 * `cancelled` into `stopped`) a person reads on every studio page, and the
 * badge that draws one. `runWord` and `pullWord` are the one place a word is
 * decided, from facts in git and the tables — never from a run's own summary
 * text — so the home, the app, a change, a tell and every list say the same
 * thing about the same commit. Nothing here knows about a page.
 */

import type { Database } from "bun:sqlite";
import { ancestorsOf } from "../../git/merge.ts";
import type { AppsRuntime, EnvStatus } from "../../apps/runtime.ts";
import type { AppRecord } from "../../core/apps.ts";
import type { Efficiency } from "../../core/efficiency.ts";
import type { WindowStanding } from "../../core/standing.ts";
import { whenText } from "../../crew/limits.ts";
import { getIssueById } from "../../core/issues.ts";
import { getPull, pullForBranch, type Pull } from "../../core/pulls.ts";
import {
  checkSummary,
  STOPPED_SUMMARY,
  type CheckDetail,
  type CheckSummary,
  type Run,
} from "../../core/runs.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../ui.ts";

export type Word =
  | "working"
  | "look"
  | "shipped"
  | "stopped"
  | "waiting"
  | "planned"
  | "told"
  | "done"
  | "cancelled";

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
    ancestry = ancestorsOf(ctx.dir, production.commitOid);
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

/** A single open pull's check, in the studio's own words — never dev's
 * "Checks passed/failed": the same five words as the rest of the page. */
function checkRunWord(check: CheckSummary): { word: Word; note: string } {
  if (check.state === "ok")
    return { word: "look", note: "green — ready for a look" };
  if (check.state === "failed") {
    const base =
      check.run?.servingAt != null
        ? "serving, but the check failed"
        : "failed before it answered";
    const detail = check.run?.checkDetail;
    return {
      word: "stopped",
      note: detail ? `${base} — ${detailNote(detail)}` : base,
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
    const production = ctx.runtime
      .status(ctx.record)
      .find((e) => e.env === "production");
    if (await caughtUp(ctx, production, commitOid))
      return { word: "shipped", note: "production is serving it" };
    return mergedPullWord(production, commitOid);
  }
  if (pull.state === "closed")
    return { word: "stopped", note: "closed without shipping" };
  return checkRunWord(checkSummary(ctx.db, pull.id, pull.headOid));
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
      : { word: "waiting", note: "paused, resumes soon" };
  if (run.state === "running") return { word: "working", note: "now" };
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
  const pull = pullFromRun(ctx.db, run);
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

const WORD_ICON: Record<Word, Parameters<typeof icon>[0]> = {
  working: "loader",
  look: "eye",
  shipped: "check",
  stopped: "alert",
  waiting: "clock",
  planned: "map",
  told: "clock",
  done: "check",
  cancelled: "ban",
};

/** One of the five (or six) studio words, as a badge. An id names the one a
 * live script repaints as a run finishes (`studioRunJs`). `cancelled` draws
 * the same quiet, secondary look as `waiting` and `planned` — a restart is
 * never the danger red a real failure earns. */
export function wordBadge(word: Word, id?: string): Html {
  const variant =
    word === "look" || word === "shipped" || word === "done"
      ? "success"
      : word === "stopped"
        ? "danger"
        : word === "working"
          ? "accent"
          : "secondary";
  return html`<span
    class="badge"
    data-variant="${variant}"
    data-word="${word}"
    ${id === undefined ? null : html`id="${id}"`}
    >${word === "working" ? icon("loader") : null}${word}</span
  >`;
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

/** An app's spend per shipped change (`core/efficiency.ts`) in a few words:
 * `$1.37 per shipped change`, or what is true when there is no ratio. */
export function perShippedWords(e: Efficiency | undefined): string {
  if (e === undefined || (e.spentUsd === 0 && e.shipped === 0))
    return "nothing spent or shipped";
  if (e.perShippedUsd === null)
    return `${dollars(e.spentUsd)} spent, nothing shipped`;
  return `${dollars(e.perShippedUsd)} per shipped change`;
}
