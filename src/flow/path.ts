/**
 * The one path a change follows, in four words a person can hold (#7703):
 * check, review, land, live. Every finer step (the check queue,
 * the merge queue, the release build, the boot check) sits one click down on
 * /boards; this module only says which of the four a pull is at and, in one
 * plain sentence, why it waits there.
 *
 * `pathStep` is plain data in, plain data out; `stepOfPull` reads the facts
 * for one pull, and the pull page, the change view and the MCP `pull` all
 * answer from it. The sentence for an open pull is `nextActor`'s, so the
 * step and "who acts next" never disagree.
 */

import type { Database } from "bun:sqlite";
import { getAppByRepo } from "../core/apps.ts";
import { latestDecisionsFor } from "../core/decisions.ts";
import { holdsFor } from "../core/holds.ts";
import { getPull, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { reviewSummariesFor, reviewSummary } from "../core/reviews.ts";
import { checksForHeads, checkSummary, type RunState } from "../core/runs.ts";
import { reviewsOff } from "../crew/review.ts";
import { nextAsking, nextOfPull, type Next } from "./next_actor.ts";
import { wallWordsOf } from "./wall_wait.ts";

export const STEPS = ["check", "review", "land", "live"] as const;
export type Step = (typeof STEPS)[number];

/** What each step is for, in one line: the /pipeline page and the strip's titles read this. */
export const STEP_MEANS: Record<Step, string> = {
  check: "Types, lint and the tests the change reaches run on the pull's own code.",
  review: "A reviewer reads the change and approves it or asks for changes.",
  land: "An approved, green pull merges into the default branch.",
  live: "A release builds the default branch and production starts serving it.",
};

export interface PathStep {
  readonly step: Step;
  /** One plain sentence: why it waits here, or that it is done. */
  readonly why: string;
  /** True once the last step is reached: live in production, or landed where nothing deploys. */
  readonly done: boolean;
}

export interface PathInput {
  readonly state: "open" | "merged" | "closed";
  /** The open pull's check on its head; ignored once merged. */
  readonly check: RunState | "none";
  readonly approvals: number;
  /** Who acts next on an open pull (`nextActor`); its reason is the sentence. */
  readonly next: Next | null;
  /** Merged pulls only: whether the base is an app's default branch, and whether production deployed since. */
  readonly deploys?: boolean;
  readonly liveSince?: boolean;
}

const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;

/** Which step the pull is at; null for a pull closed without landing. */
export function pathStep(i: PathInput): PathStep | null {
  if (i.state === "closed") return null;
  if (i.state === "merged") {
    if (i.deploys !== true)
      return { step: "land", why: "Landed; nothing deploys from this branch, so this is the end of its path.", done: true };
    return i.liveSince === true
      ? { step: "live", why: "Landed and live in production.", done: true }
      : { step: "live", why: "Landed; it goes live with the next production release.", done: false };
  }
  // The earliest of the four not yet passed: a check on this head that is not
  // green, then an approval. No check recorded is no check to wait for.
  const checking = i.check !== "ok" && i.check !== "none";
  const step: Step = checking ? "check" : i.approvals > 0 ? "land" : "review";
  // nextActor names review before a running check; on the check step the check is the reason.
  const why =
    step === "check" && (i.next === null || i.next.who === "reviewer")
      ? CHECK_WORDS[i.check as Exclude<RunState, "ok">]
      : (i.next?.why ?? "waiting");
  return { step, why: sentence(why), done: false };
}

const CHECK_WORDS: Record<Exclude<RunState, "ok">, string> = {
  queued: "its check is queued",
  running: "its check is running",
  failed: "its check is red",
  cancelled: "its check was cancelled",
};

/** Whether production for `repo` has deployed since `at`. */
function deployedSince(db: Database, repoId: string, at: string): boolean {
  return (
    db
      .query<{ n: number }, [string, string]>(
        `SELECT 1 AS n FROM run
          WHERE repo_id = ?1 AND kind = 'deploy' AND env = 'production'
            AND created_at >= ?2 AND serving_at IS NOT NULL LIMIT 1`,
      )
      .get(repoId, at) !== null
  );
}

/**
 * The step of `pull` in `repo`. `live` is the open pull's head and conflicts
 * as the caller already read them, and `next` is the `nextOfPull` it already
 * computed for the same head, so one render reads the facts once.
 */
export function stepOfPull(
  db: Database,
  repo: Repo,
  pull: Pull,
  live: { readonly headOid: string; readonly conflicts: number },
  next: Next | null = pull.state === "open" && pull.mergedAt === null ? nextOfPull(db, pull, live, repo) : null,
): PathStep | null {
  if (pull.mergedAt !== null) {
    const deploys = pull.baseBranch === repo.defaultBranch && getAppByRepo(db, repo.id) !== undefined;
    return pathStep({
      state: "merged",
      check: "ok",
      approvals: 0,
      next: null,
      deploys,
      liveSince: deploys && deployedSince(db, repo.id, pull.mergedAt),
    });
  }
  if (pull.state !== "open") return null;
  return pathStep({
    state: "open",
    check: checkSummary(db, pull.id, live.headOid).state,
    approvals: reviewSummary(db, pull.id, live.headOid).approvals,
    next,
  });
}

/** The step as its heading reads: "Check". The one capitalisation every surface shares. */
export const stepWord = (step: Step): string => `${step.charAt(0).toUpperCase()}${step.slice(1)}`;

/** The step and why in one plain line, for the terminal and anywhere text is all there is. */
export const stepLine = (p: PathStep): string => `${stepWord(p.step)}${p.done ? " (done)" : ""} — ${p.why}`;

/** `stepOfPull` for a list: the head as stored, no conflict probe (a list does not open the repository). */
export function stepOfStored(db: Database, repo: Repo, pull: Pull): PathStep | null {
  return stepOfPull(db, repo, pull, { headOid: pull.headOid, conflicts: 0 });
}

/** `stepOfStored` for the pull a repository numbers `number`; null for an issue, a missing number, or a pull closed unmerged. */
export function stepOfNumber(db: Database, repo: Repo, number: number): PathStep | null {
  const pull = getPull(db, repo.id, number);
  return pull === undefined ? null : stepOfStored(db, repo, pull);
}

/** When production for `repo` last started serving a deploy; null when it never has. */
function lastServed(db: Database, repoId: string): string | null {
  return (
    db
      .query<{ at: string | null }, [string]>(
        `SELECT MAX(created_at) AS at FROM run
          WHERE repo_id = ?1 AND kind = 'deploy' AND env = 'production' AND serving_at IS NOT NULL`,
      )
      .get(repoId)?.at ?? null
  );
}

/**
 * `stepOfStored` for every pull of a list at once, by pull id: each fact is
 * read in one query for the whole page rather than once per row, so a list
 * renders without touching the database (#8387). Same steps, same words.
 */
export function stepsOfStored(db: Database, repo: Repo, pulls: readonly Pull[]): Map<string, PathStep | null> {
  const out = new Map<string, PathStep | null>();
  const open = pulls.filter((p) => p.mergedAt === null && p.state === "open");
  const ids = open.map((p) => p.id);
  const reviews = reviewSummariesFor(db, open);
  const checks = checksForHeads(db, new Map(open.map((p) => [p.id, p.headOid])));
  const holds = holdsFor(db, ids);
  const walls = latestDecisionsFor(db, ids, "land");
  // Asked at most once for the batch, and only if a pull would wait on a review (#11666).
  let off: boolean | undefined;
  const reviewOff = (): boolean => (off ??= reviewsOff(db, repo));
  for (const pull of open) {
    const r = reviews.get(pull.id)!;
    const check = checks.get(pull.id)?.[0]?.state ?? "none";
    const hold = holds.get(pull.id);
    const next = nextAsking(
      {
        held: hold === undefined ? null : { by: hold.heldByName, why: hold.why },
        conflicted: false,
        check,
        changesRequested: r.changesRequested,
        approvals: r.approvals,
        pushedSince: r.stale,
        wall: wallWordsOf(walls.get(pull.id), pull.headOid),
      },
      reviewOff,
    );
    out.set(pull.id, pathStep({ state: "open", check, approvals: r.approvals, next }));
  }
  const merged = pulls.filter((p) => p.mergedAt !== null);
  const toDefault = merged.some((p) => p.baseBranch === repo.defaultBranch);
  const hasApp = toDefault && getAppByRepo(db, repo.id) !== undefined;
  const served = hasApp ? lastServed(db, repo.id) : null;
  for (const pull of merged) {
    const deploys = hasApp && pull.baseBranch === repo.defaultBranch;
    out.set(
      pull.id,
      pathStep({
        state: "merged",
        check: "ok",
        approvals: 0,
        next: null,
        deploys,
        liveSince: deploys && served !== null && served >= pull.mergedAt!,
      }),
    );
  }
  for (const pull of pulls) if (!out.has(pull.id)) out.set(pull.id, null);
  return out;
}
