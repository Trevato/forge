/**
 * The sync loop: keeping mirrors in step with their origins.
 *
 * Invariant 4 says git is truth and the database is a derived index. This
 * file is that sentence with a different subject — **the origin is truth**,
 * and a mirror's rows are a cache that can always be thrown away and rebuilt.
 * Nothing here merges, reconciles or resolves a conflict, because nothing
 * here ever wrote a local version that could diverge.
 *
 * Three rules make it converge rather than drift, all borrowed from the one
 * piece of prior art that actually does incremental sync (git-bug):
 *
 * 1. **The watermark is when the run started**, not the newest `updated_at`
 *    seen. Using the max loses anything modified mid-run.
 * 2. **The watermark advances only on a completely clean run.** A 502 on
 *    page seven turns into a re-fetch instead of a hole.
 * 3. **A five-minute overlap** on every query, because `since` filters on
 *    `updated_at` and nobody documents what bumps it. Replaying the overlap
 *    is free: every upsert is keyed on the origin's stable id.
 *
 * And one rule of its own: this never throws. It is a worker tick, and a
 * thrown rejection in a timer takes the process down.
 */

import { existsSync } from "node:fs";
import { forgetListings } from "../core/listings.ts";
import type { App } from "../app.ts";
import {
  cacheOriginRepos,
  getCursor,
  listAllOrigins,
  listMirrors,
  markNeedsReauth,
  originForRepo,
  recordFetch,
  rememberOriginRepo,
  recordSync,
  setCursor,
  type Origin,
} from "../core/origins.ts";
import { storageStale } from "../core/storage.ts";
import { getRepoById } from "../core/repos.ts";
import { settingMoved } from "../core/settings_changed.ts";
import { pullDiff, type Pull, getPull } from "../core/pulls.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import { bustOrigin } from "../view/cache.ts";
import { aheadOf, forgetAhead, HELD_WORDS } from "./ahead.ts";
import { providerForOrigin } from "./credential.ts";
import { fetchMirror } from "./git-mirror.ts";
import {
  importComments,
  importIssue,
  importLabels,
  importReviews,
  importReviewStates,
} from "./import.ts";
import { refreshOpenPulls } from "./pull-check.ts";
import type { Provider, ProviderFailure, RemoteIssue } from "./types.ts";

const log = createLog("origins");

/** How often an origin is swept when nothing asks for it sooner. */
export const SYNC_INTERVAL_MS = 10 * 60 * 1000;
/** The `since` overlap — clock skew, CDN caching, and index lag. */
export const OVERLAP_MS = 5 * 60 * 1000;
/** Pages of issues (or pulls) walked in one repo pass. */
const MAX_PAGES = 20;
/** Origins swept per tick, so one slow forge cannot starve the rest. */
const MAX_PER_TICK = 4;

const CURSOR_NEXT = "next_sync_at";
const CURSOR_PAUSED = "paused_until";
const issuesKey = (repoId: string): string => `repo:${repoId}:issues`;
const pullsKey = (repoId: string): string => `repo:${repoId}:pulls`;

/** One origin at a time. A second caller joins the run already in flight. */
const inFlight = new Map<string, Promise<SyncReport>>();

export interface SyncReport {
  readonly originId: string;
  readonly repos: number;
  readonly refsMoved: number;
  readonly issues: number;
  readonly pulls: number;
  readonly comments: number;
  /** Empty when the whole run succeeded — the condition for advancing. */
  readonly error: string;
  /** Set when the origin asked us to wait. */
  readonly retryAt?: string;
}

const empty = (originId: string): SyncReport => ({
  originId,
  repos: 0,
  refsMoved: 0,
  issues: 0,
  pulls: 0,
  comments: 0,
  error: "",
});

/**
 * Where a run has got to, for anyone watching. The mirror job renders this;
 * the worker passes nothing and pays nothing. Never awaited and never
 * trusted: a reporter that throws must not derail a sync.
 */
export type SyncProgress = (
  stage: "fetching" | "labels" | "issues" | "pulls" | "comments",
  detail: string,
) => void;

export interface SyncOptions {
  /** First import of a repo: one summary event instead of an event storm. */
  readonly initial?: boolean;
  /** Sync only this repo (the "sync this mirror now" path). */
  readonly onlyRepoId?: string;
  /**
   * Sync now on one mirror: a person asked for the origin's branches, so a
   * default branch holding commits the origin lacks is overwritten. Without
   * it such a mirror is held (see `origins/ahead.ts`).
   */
  readonly overwrite?: boolean;
  /** Live stage reports, for a mirror job with a UI attached. */
  readonly onProgress?: SyncProgress;
}

/**
 * Sync one origin: refresh its repo list, then every mirror hanging off it.
 * Runs serially per origin — two concurrent passes would race on the same
 * cursors and duplicate every request.
 */
export function syncOrigin(
  app: App,
  origin: Origin,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const running = inFlight.get(origin.id);
  if (running) return running;
  const run = runOrigin(app, origin, options).finally(() => {
    inFlight.delete(origin.id);
  });
  inFlight.set(origin.id, run);
  return run;
}

/**
 * Resolves once no origin sync is running, however each ended. It loops, so a
 * sync that starts while it waits (a reconnect chaining another) is awaited too.
 */
export async function syncsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
}

async function runOrigin(
  app: App,
  origin: Origin,
  options: SyncOptions,
): Promise<SyncReport> {
  const startedAt = new Date().toISOString();
  const report = { ...empty(origin.id) } as {
    -readonly [K in keyof SyncReport]: SyncReport[K];
  };

  if (origin.needsReauth) {
    report.error = "this origin needs to be reconnected";
    recordSync(app.db, origin.id, { at: startedAt, error: report.error });
    schedule(app, origin.id, SYNC_INTERVAL_MS);
    return report;
  }

  const provider = providerForOrigin(app, origin);
  if (!provider.ok) {
    report.error = `this origin has no stored token: reconnect ${origin.login} at ${origin.webUrl}`;
    markNeedsReauth(app.db, origin.id, report.error);
    recordSync(app.db, origin.id, { at: startedAt, error: report.error });
    schedule(app, origin.id, SYNC_INTERVAL_MS);
    return report;
  }

  // The picker's rows, refreshed opportunistically: a failure here is not a
  // reason to skip the mirrors, which are what people actually depend on.
  if (options.onlyRepoId === undefined) {
    const listed = await provider.value.listRepos();
    if (listed.ok) {
      cacheOriginRepos(app.db, origin.id, listed.value.items);
    } else if (listed.error.error === "rate_limited") {
      return pause(app, origin, startedAt, listed.error, report);
    }
  }

  for (const mirror of listMirrors(app.db, origin.id)) {
    if (
      options.onlyRepoId !== undefined &&
      mirror.repoId !== options.onlyRepoId
    )
      continue;
    report.repos++;
    const outcome = await syncMirror(
      app,
      origin,
      provider.value,
      mirror,
      options,
    );
    report.refsMoved += outcome.refsMoved;
    report.issues += outcome.issues;
    report.pulls += outcome.pulls;
    report.comments += outcome.comments;
    if (outcome.rateLimited) {
      return pause(app, origin, startedAt, outcome.rateLimited, report);
    }
    if (outcome.error !== "") report.error = outcome.error;
  }

  recordSync(app.db, origin.id, {
    at: new Date().toISOString(),
    ...(report.error === "" ? {} : { error: report.error }),
  });
  schedule(app, origin.id, SYNC_INTERVAL_MS);
  return report;
}

function pause(
  app: App,
  origin: Origin,
  startedAt: string,
  failure: ProviderFailure,
  report: { -readonly [K in keyof SyncReport]: SyncReport[K] },
): SyncReport {
  const retryAt =
    failure.retryAt ?? new Date(Date.now() + SYNC_INTERVAL_MS).toISOString();
  report.error = failure.message;
  report.retryAt = retryAt;
  setCursor(app.db, origin.id, CURSOR_PAUSED, retryAt);
  setCursor(app.db, origin.id, CURSOR_NEXT, retryAt);
  recordSync(app.db, origin.id, { at: startedAt, error: failure.message });
  log.warn("origin rate-limited", { origin: origin.id, until: retryAt });
  return report;
}

function schedule(app: App, originId: string, inMs: number): void {
  setCursor(
    app.db,
    originId,
    CURSOR_NEXT,
    new Date(Date.now() + inMs).toISOString(),
  );
}

interface MirrorOutcome {
  refsMoved: number;
  issues: number;
  pulls: number;
  comments: number;
  error: string;
  rateLimited?: ProviderFailure;
}

/**
 * One mirror, and nothing it does can escape as a throw. A mirror whose
 * directory was removed by hand, or any other surprise below, becomes this
 * repo's `fetch_error`; the next mirror and the next origin still run. A
 * throw here would otherwise abort the whole tick at this origin, leave its
 * `next_sync_at` unadvanced, and so repeat the same abort every tick —
 * starving every origin behind it forever.
 */
async function syncMirror(
  app: App,
  origin: Origin,
  provider: Provider,
  mirror: { repoId: string; fullName: string },
  options: SyncOptions,
): Promise<MirrorOutcome> {
  try {
    return await syncMirrorUnguarded(app, origin, provider, mirror, options);
  } catch (error) {
    const message = `sync failed: ${String(error)}`;
    log.warn("mirror sync threw", { repo: mirror.repoId, error: message });
    recordFetch(app.db, mirror.repoId, {
      at: new Date().toISOString(),
      error: message,
    });
    return { refsMoved: 0, issues: 0, pulls: 0, comments: 0, error: message };
  }
}

async function syncMirrorUnguarded(
  app: App,
  origin: Origin,
  provider: Provider,
  mirror: { repoId: string; fullName: string },
  options: SyncOptions,
): Promise<MirrorOutcome> {
  const out: MirrorOutcome = {
    refsMoved: 0,
    issues: 0,
    pulls: 0,
    comments: 0,
    error: "",
  };
  let repo = getRepoById(app.db, mirror.repoId);
  if (!repo) return out;
  // The git directory is the repo (invariant 4); without it there is
  // nothing to fetch into and nothing to diff against, and `Bun.spawn` would
  // throw on the missing cwd before git ever ran.
  if (!existsSync(repoDir(app.reposRoot, repo.ownerName, repo.name))) {
    out.error = "the mirror's git directory is missing";
    recordFetch(app.db, repo.id, {
      at: new Date().toISOString(),
      error: out.error,
    });
    return out;
  }

  // Re-read the repo from the origin every sweep, for one reason: a repo
  // flipped to private upstream must stop being readable here. Visibility is
  // the origin's to decide, and a mirror that keeps serving a repo the
  // origin has closed is a leak we caused. (It also refreshes the clone URL
  // after a rename.)
  const described = await provider.getRepo(mirror.fullName);
  if (described.ok) {
    rememberOriginRepo(app.db, origin.id, described.value);
    // Narrow only. Going private upstream must close the mirror at once;
    // going public upstream is a decision the owner confirms here, because
    // a mirror that widens on its own would publish whatever a compromised
    // or mistaken origin says is public.
    const wanted = described.value.private ? "private" : "public";
    if (wanted === "private" && repo.visibility !== "private") {
      app.db
        .query("UPDATE repo SET visibility = ?1 WHERE id = ?2")
        .run(wanted, repo.id);
      forgetListings(app.db);
      app.bus.append({
        kind: "repo.settings_updated",
        repoId: repo.id,
        actorId: origin.userId,
        payload: { changed: settingMoved("visibility", repo.visibility, wanted), visibility: wanted, via: "origin" },
      });
      repo = getRepoById(app.db, repo.id)!;
    }
  } else if (described.error.error === "rate_limited") {
    out.rateLimited = described.error;
    return out;
  }

  // A watcher's throw is never this loop's problem (the same rule the event
  // bus keeps for its listeners).
  const report: SyncProgress = (stage, detail) => {
    try {
      options.onProgress?.(stage, detail);
    } catch {
      // a UI that cannot receive a stage is not a reason to stop syncing
    }
  };

  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const cloneUrl = originForRepo(app.db, repo.id)?.cloneUrl ?? "";
  // Captured before the first request: anything changed mid-run is caught by
  // the next pass rather than skipped by an over-eager watermark.
  const runStarted = new Date().toISOString();

  // ---- git ----
  // A mirror whose default branch holds commits the origin lacks (the last
  // reading said so) is held: its page says taking would overwrite them, and
  // the sweep keeps that true. Only Sync now, a person's word, overwrites.
  const held = options.overwrite !== true && aheadOf(app, repo)?.diverged === true;
  if (held) {
    recordFetch(app.db, repo.id, { at: runStarted, error: HELD_WORDS(repo.defaultBranch) });
  } else if (cloneUrl !== "") {
    report("fetching", "fetching git objects");
    const authEnv = await provider.gitAuthEnv(cloneUrl);
    const fetched = await fetchMirror(dir, cloneUrl, authEnv);
    if (!fetched.ok) {
      out.error = fetched.error.message;
      recordFetch(app.db, repo.id, {
        at: runStarted,
        error: fetched.error.message,
      });
    } else {
      recordFetch(app.db, repo.id, { at: runStarted });
      forgetAhead(app, origin.id, repo.id);
      out.refsMoved = fetched.value.changes.length;
      if (fetched.value.changes.length > 0) {
        // Objects were written without a push: measure again at the next check.
        storageStale(app, repo.ownerId);
        // Shaped exactly like a native push event, plus the flag that says
        // where it came from — so webhooks, SSE and the activity feed see
        // upstream work without learning a new event kind.
        app.bus.append({
          kind: "push",
          repoId: repo.id,
          actorId: origin.userId,
          payload: {
            updates: fetched.value.changes.map((c) => ({
              ref: c.ref,
              oldOid: c.oldOid,
              newOid: c.newOid,
            })),
            via: "origin",
          },
        });
      }
    }
  }

  // ---- labels, then items ----
  report("labels", "importing labels");
  const labels = await provider.listLabels(mirror.fullName);
  if (labels.ok) {
    importLabels(app.db, repo.id, labels.value);
    report("labels", plural(labels.value.length, "label"));
  } else if (labels.error.error === "rate_limited") {
    out.rateLimited = labels.error;
    return out;
  } else out.error = labels.error.message;

  const ctx = { db: app.db, repoId: repo.id, actorId: origin.userId };

  for (const kind of ["issue", "pull"] as const) {
    const key = kind === "issue" ? issuesKey(repo.id) : pullsKey(repo.id);
    const watermark = getCursor(app.db, origin.id, key);
    const since =
      watermark === undefined
        ? undefined
        : new Date(Date.parse(watermark) - OVERLAP_MS).toISOString();

    let cursor: string | undefined;
    let clean = true;
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await provider.listIssues(mirror.fullName, {
        kind,
        state: "all",
        ...(since === undefined ? {} : { since }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!listed.ok) {
        clean = false;
        if (listed.error.error === "rate_limited") {
          out.rateLimited = listed.error;
          return out;
        }
        out.error = listed.error.message;
        break;
      }
      for (const remote of listed.value.items) {
        // The origin's number becomes ours and drags `issue_seq` with it;
        // a non-positive or non-integer one is a row we will not make.
        if (!Number.isInteger(remote.number) || remote.number < 1) continue;
        const imported = importIssue(ctx, remote);
        if (kind === "issue") {
          out.issues++;
          report("issues", plural(out.issues, "issue"));
        } else {
          out.pulls++;
          report("pulls", plural(out.pulls, "pull"));
        }

        // Comments and reviews only for items that actually moved — this is
        // what keeps a sweep O(changed) rather than O(everything).
        if (imported.changed) {
          const before = out.comments;
          out.comments += await importThread(
            provider,
            ctx,
            mirror.fullName,
            imported.issueId,
            remote,
            dir,
            since,
          );
          if (out.comments !== before)
            report("comments", plural(out.comments, "comment"));
        }

        if (!options.initial && imported.created) {
          app.bus.append({
            kind: kind === "issue" ? "issue.opened" : "pull.opened",
            repoId: repo.id,
            actorId: origin.userId,
            payload: {
              number: remote.number,
              via: "origin",
              originAuthor: remote.author,
            },
          });
        }
        if (!options.initial && imported.newlyMerged) {
          app.bus.append({
            kind: "pull.merged",
            repoId: repo.id,
            actorId: origin.userId,
            payload: { number: remote.number, via: "origin" },
          });
        }
      }
      if (listed.value.next === null) break;
      cursor = listed.value.next;
    }
    // Rule 2: a run that saw any error does not move the watermark.
    if (clean && out.error === "")
      setCursor(app.db, origin.id, key, runStarted);
  }

  // A check finishing or a review landing does not move a pull's updated
  // time on every origin, so the open pulls are read again each sweep: the
  // catch-up for a webhook that never came.
  await refreshOpenPulls(ctx, provider, mirror.fullName);

  // Whatever the browse cache holds for this remote was true before this
  // sweep and is a guess after it. Dropping it costs one request; keeping it
  // means a page that shows a stale answer with a fresh timestamp.
  bustOrigin(origin.id, mirror.fullName);

  if (options.initial) {
    // One event for a first import, not one per row: a repo with 900 issues
    // would otherwise deliver 900 webhooks the moment it is connected.
    app.bus.append({
      kind: "repo.imported",
      repoId: repo.id,
      actorId: origin.userId,
      payload: {
        origin: origin.webUrl,
        fullName: mirror.fullName,
        issues: out.issues,
        pulls: out.pulls,
        comments: out.comments,
        refs: out.refsMoved,
        via: "origin",
      },
    });
  }
  return out;
}

/** "1 issue" / "42 issues" — a job's detail line, not a sentence. */
const plural = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Comments, and for a pull its inline review comments. */
async function importThread(
  provider: Provider,
  ctx: { db: App["db"]; repoId: string; actorId: string },
  fullName: string,
  issueId: string,
  remote: RemoteIssue,
  dir: string,
  since: string | undefined,
): Promise<number> {
  let added = 0;
  const comments = await provider.listComments(fullName, remote.number, since);
  if (comments.ok) added += importComments(ctx, issueId, comments.value);

  if (remote.pull === undefined) return added;

  // The verdicts first: one request, and the only part of a review that
  // gates a merge. A failure here is not worth abandoning the comments for.
  const states = await provider.listReviewStates(fullName, remote.number);
  if (states.ok) added += importReviewStates(ctx, issueId, states.value);

  const reviews = await provider.listReviews(fullName, remote.number);
  if (!reviews.ok || reviews.value.length === 0) return added;

  // The anchor check needs the diff we actually hold. A pull whose head is a
  // fork we never fetched has none, and every imported comment on it is
  // stored as outdated — which is the truth, not a degradation.
  const pull = getPull(ctx.db, ctx.repoId, remote.number);
  const diff = pull ? await diffFor(dir, pull) : undefined;
  added += importReviews(
    ctx,
    issueId,
    remote.pull.headOid,
    diff,
    reviews.value,
  );
  return added;
}

async function diffFor(dir: string, pull: Pull) {
  try {
    const { diff } = await pullDiff(dir, pull);
    return diff;
  } catch {
    return undefined;
  }
}

// ---- the worker ----

/** Origins whose next-sync time has passed (and who are not paused). */
export function dueOrigins(app: App, now = new Date()): Origin[] {
  const nowIso = now.toISOString();
  const due: Origin[] = [];
  for (const origin of listAllOrigins(app.db)) {
    if (origin.needsReauth) continue;
    const paused = getCursor(app.db, origin.id, CURSOR_PAUSED);
    if (paused !== undefined && paused > nowIso) continue;
    const next = getCursor(app.db, origin.id, CURSOR_NEXT);
    if (next !== undefined && next > nowIso) continue;
    due.push(origin);
    if (due.length >= MAX_PER_TICK) break;
  }
  return due;
}

/** Ask for a sync as soon as the worker next ticks. */
export function requestSyncNow(app: App, originId: string): void {
  setCursor(app.db, originId, CURSOR_NEXT, new Date(0).toISOString());
}

export async function syncDue(app: App, now = new Date()): Promise<number> {
  const due = dueOrigins(app, now);
  for (const origin of due) {
    try {
      await syncOrigin(app, origin);
    } catch (error) {
      // One origin's surprise is that origin's problem. Its next-due time is
      // pushed out like any failed run, so it cannot monopolise every tick.
      log.error("origin sync threw", {
        origin: origin.id,
        error: String(error),
      });
      recordSync(app.db, origin.id, {
        at: now.toISOString(),
        error: `sync failed: ${String(error)}`,
      });
      schedule(app, origin.id, SYNC_INTERVAL_MS);
    }
  }
  return due.length;
}

/**
 * The timer's entry point — `runDelivery`'s twin, and it keeps the same
 * promise: a failed batch is logged, never rethrown. A rejection escaping a
 * `setInterval` callback takes the process down, which is a lesson this
 * codebase has already paid for once.
 */
export function runSync(app: App): void {
  // Single-flight, for the same reason the delivery worker is. A sweep of
  // four origins over a slow network outlives the sixty-second tick easily,
  // and a second sweep starting on top of the first would re-fetch every
  // page the first is still walking — doubling the load on an origin that
  // was already the reason the sweep is slow. `syncOrigin` already refuses
  // to run twice for one origin; this is the same promise for the batch.
  //
  // Per forge, not per process: two forges in one process have unrelated
  // origins and must not gate each other's sweeps.
  if (sweeping.has(app)) return;
  sweeping.add(app);
  syncDue(app)
    .catch((error: unknown) => {
      app.log.error("origin sync batch failed", { error: String(error) });
    })
    .finally(() => {
      sweeping.delete(app);
    });
}

const sweeping = new WeakSet<App>();

/** For tests, and for anyone asking why a tick did nothing. */
export const syncBusy = (app: App): boolean => sweeping.has(app);
