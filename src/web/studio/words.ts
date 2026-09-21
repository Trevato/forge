/**
 * The studio's vocabulary: the five words (and the three that only ever fold
 * into them — `waiting`, `planned` into `working`, `done` into `shipped`) a
 * person reads on every studio page, and the badge that draws one. `runWord`
 * and `pullWord` are the one place a word is decided, from facts in git and
 * the tables — never from a run's own summary text — so the home, the app, a
 * change, a tell and every list say the same thing about the same commit.
 * Nothing here knows about a page.
 */

import type { Database } from "bun:sqlite";
import { mergeBase } from "../../git/merge.ts";
import type { AppsRuntime, EnvStatus } from "../../apps/runtime.ts";
import type { AppRecord } from "../../core/apps.ts";
import { getIssueById } from "../../core/issues.ts";
import { getPull, pullForBranch, type Pull } from "../../core/pulls.ts";
import {
  checkSummary,
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
  | "done";

/**
 * Everything the word functions below need to see production: the repo's
 * git directory (an ancestry check reads it), and the runtime plus the
 * app record, when the repository runs one. Built once per page and
 * threaded through — never a second way to ask what is serving.
 */
export interface WordCtx {
  readonly db: Database;
  readonly dir: string;
  readonly runtime: AppsRuntime | undefined;
  readonly record: AppRecord | undefined;
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

/** Whether production is serving this commit, or something later than it. */
async function caughtUp(
  dir: string,
  production: EnvStatus | undefined,
  commitOid: string,
): Promise<boolean> {
  if (production === undefined || production.commitOid === "") return false;
  if (production.commitOid === commitOid) return true;
  return (await mergeBase(dir, commitOid, production.commitOid)) === commitOid;
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
    if (await caughtUp(ctx.dir, production, commitOid))
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
  if (run.state === "failed" || run.state === "cancelled")
    return { word: "stopped", note: run.summary || run.state };
  const pull = pullFromRun(ctx.db, run);
  if (pull !== undefined) return await pullWord(ctx, pull);
  if (run.kind !== "agent")
    return {
      word: "done",
      note: run.summary || (run.kind === "deploy" ? "deployed" : "checked"),
    };
  return { word: "planned", note: run.summary || "nothing to show yet" };
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
};

/** One of the five (or six) studio words, as a badge. An id names the one a
 * live script repaints as a run finishes (`studioRunJs`). */
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
