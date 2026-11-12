/**
 * Where a new or migrated app stands, in one line, until production runs
 * (#10295). The states are listed in `docs/features/onboarding-line.md`.
 * The line is judged from the pulls and runs the forge already keeps; a
 * failure carries the failing line and its log for a viewer who may read
 * run logs, and only "a check failed" for anyone else.
 *
 * Only a new app has a line: one created since this shipped
 * (`ONBOARDING_SINCE`) and in the last `ONBOARDING_WINDOW_MS`. An older app
 * never shows one and never notifies.
 *
 * Plain data in, plain data out: `onboardingLine` judges facts, and
 * `onboardingFacts` reads them.
 */

import type { Database } from "bun:sqlite";
import { mayReadRunLog } from "../actions/runs.ts";
import type { App } from "../app.ts";
import { getAppByRepo, type AppRecord } from "../core/apps.ts";
import { listPulls, type Pull } from "../core/pulls.ts";
import { canSeeOwnerFacts, getRepoById, type Repo } from "../core/repos.ts";
import { listRuns, type Run } from "../core/runs.ts";
import { sealedScope } from "../core/sealed.ts";
import type { User } from "../core/users.ts";
import { failingLine } from "../crew/red_approved.ts";

export type OnboardingState =
  | "imported"
  | "making"
  | "failed"
  | "retrying"
  | "preview"
  | "deploying"
  | "stopped"
  | "live";

export interface OnboardingLine {
  readonly state: OnboardingState;
  /** The sentence, ending in a full stop. */
  readonly text: string;
  /** Where its link goes, relative to the forge; with `linkLabel`. */
  readonly href?: string;
  readonly linkLabel?: string;
}

/** How long "live" is still said after production first answered. */
export const LIVE_SAID_MS = 24 * 3_600_000;

/** Apps created before this never get a line: they were not new when it shipped. */
export const ONBOARDING_SINCE = "2026-11-09T00:00:00.000Z";

/** How long after it was created an app that never ran still carries its line. */
export const ONBOARDING_WINDOW_MS = 14 * 24 * 3_600_000;

/** Whether an app created at `createdAt` is new enough to have a line at `now`. */
export function isOnboarding(createdAt: string, now: number): boolean {
  return createdAt >= ONBOARDING_SINCE && now - Date.parse(createdAt) <= ONBOARDING_WINDOW_MS;
}

export interface OnboardingFacts {
  readonly base: string;
  /** When the app was created. */
  readonly createdAt: string;
  /** Newest first. */
  readonly pulls: readonly Pick<Pull, "number" | "state" | "mergedAt" | "authorName" | "authorIsAgent" | "id">[];
  /** Runs about the newest pull, newest first. */
  readonly runs: readonly Run[];
  /** When production first served, if it has. */
  readonly liveAt: string | null;
  readonly now: number;
  /** Whether the viewer reads the crew by name (the owner does; a visitor reads "the crew"). */
  readonly named: boolean;
  /** Whether the viewer may read run logs, and so the failing line and its link. */
  readonly logs: boolean;
}

const isCheck = (r: Run): boolean => r.kind === "deploy" || r.kind === "check";
const active = (r: Run): boolean => r.state === "queued" || r.state === "running";

const LOG_LABEL = "Failing run log";

/** What a failed check says: its failing line and log for those who may read logs. */
function failure(f: OnboardingFacts, state: "failed" | "retrying", run: Run): OnboardingLine {
  const lead = state === "failed" ? "Check failed" : "Retrying after a failed check";
  if (!f.logs) return { state, text: state === "failed" ? "A check failed." : "Retrying after a failed check." };
  return { state, text: `${lead}: ${failingLine(run)}`, href: `${f.base}/runs/${run.id}`, linkLabel: LOG_LABEL };
}

export function onboardingLine(f: OnboardingFacts): OnboardingLine | undefined {
  if (!isOnboarding(f.createdAt, f.now)) return undefined;
  if (f.liveAt !== null) {
    if (f.now - Date.parse(f.liveAt) > LIVE_SAID_MS) return undefined;
    return { state: "live", text: "Live.", href: `${f.base}/app`, linkLabel: "The app" };
  }
  const pull = f.pulls.find((p) => p.state === "open") ?? f.pulls.find((p) => p.mergedAt !== null);
  if (pull === undefined) {
    const closed = f.pulls[0];
    if (closed !== undefined)
      return {
        state: "stopped",
        text: `The crew stopped: pull #${closed.number} closed without landing. It needs you.`,
        href: `${f.base}/pulls/${closed.number}`,
        linkLabel: `Pull #${closed.number}`,
      };
    return { state: "imported", text: "Imported. The crew has not started making it run yet." };
  }
  const by = pull.authorIsAgent ? ` by ${f.named ? pull.authorName : "the crew"}` : "";
  if (pull.state !== "open")
    return {
      state: "deploying",
      text: `Pull #${pull.number}${by} landed. Production is starting.`,
      href: `${f.base}/pulls/${pull.number}`,
      linkLabel: `Pull #${pull.number}`,
    };
  const checks = f.runs.filter(isCheck);
  const latest = checks[0];
  const failedBefore = checks.find((r) => r.state === "failed");
  const crewBusy = f.runs.some((r) => r.kind === "agent" && active(r));
  // A preview that answered after the last failure ends the retrying.
  const servedAt = checks.findIndex((r) => r.kind === "deploy" && r.servingAt !== null);
  const failedAt = checks.findIndex((r) => r.state === "failed");
  if (servedAt >= 0 && (failedAt < 0 || servedAt < failedAt))
    return { state: "preview", text: `Preview up for pull #${pull.number}.` };
  if (latest?.state === "failed") return failure(f, crewBusy ? "retrying" : "failed", latest);
  if (latest !== undefined && active(latest) && failedBefore !== undefined) return failure(f, "retrying", failedBefore);
  return {
    state: "making",
    // No link: the open pull is listed, linked, right below on the app page.
    text: `The crew is making it run (pull #${pull.number}${by}).`,
  };
}

/**
 * When production first served, per app. Once set it never changes, so it is
 * read once; an app that has not served is asked again (it may yet).
 */
const liveAtCache = new WeakMap<Database, Map<string, string>>();

function firstServedAt(db: Database, repoId: string): string | null {
  const seen = liveAtCache.get(db) ?? new Map<string, string>();
  liveAtCache.set(db, seen);
  const known = seen.get(repoId);
  if (known !== undefined) return known;
  const at =
    db
      .query<{ at: string | null }, [string]>(
        `SELECT MIN(serving_at) AS at FROM run WHERE repo_id = ?1 AND kind = 'deploy' AND env = 'production' AND serving_at IS NOT NULL`,
      )
      .get(repoId)?.at ?? null;
  if (at !== null) seen.set(repoId, at);
  return at;
}

/**
 * The facts for one app, as the viewer may see its pulls. An app that is
 * not new, or has served production for longer than `LIVE_SAID_MS`, has
 * nothing to say, so its pulls and runs are not read. `logs` is whether the
 * viewer may read run logs (`mayReadRunLog`).
 */
export function onboardingFacts(
  db: Database,
  repo: Repo,
  app: AppRecord,
  base: string,
  viewer: User | undefined,
  logs: boolean,
  now = Date.now(),
): OnboardingFacts {
  const named = canSeeOwnerFacts(db, repo, viewer);
  const quiet = { base, createdAt: app.createdAt, pulls: [], runs: [], now, named, logs };
  if (!isOnboarding(app.createdAt, now)) return { ...quiet, liveAt: null };
  const liveAt = firstServedAt(db, app.repoId);
  if (liveAt !== null && now - Date.parse(liveAt) > LIVE_SAID_MS) return { ...quiet, liveAt };
  const pulls = listPulls(db, repo.id, { state: "all", limit: 10, ...sealedScope(db, repo, viewer) });
  const newest = pulls.find((p) => p.state === "open") ?? pulls.find((p) => p.mergedAt !== null);
  const runs = newest === undefined ? [] : listRuns(db, repo.id, { issueId: newest.id, limit: 30 });
  return { ...quiet, pulls, runs, liveAt };
}

/**
 * The line for one app as the viewer may read it, until production runs:
 * the app page's head and the terminal both call this. Once live, the head
 * says so itself, so "live" is the notifier's alone.
 */
export function appOnboardingLine(app: App, repo: Repo, viewer: User | undefined): OnboardingLine | undefined {
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined || !isOnboarding(record.createdAt, Date.now())) return undefined;
  const logs = mayReadRunLog(app, viewer, repo);
  const line = onboardingLine(onboardingFacts(app.db, repo, record, `/${repo.ownerName}/${repo.name}`, viewer, logs));
  return line?.state === "live" ? undefined : line;
}

/**
 * The owner's apps the notifier looks at: new ones (`isOnboarding`) that
 * have not served production for longer than `LIVE_SAID_MS`. One query;
 * every other app is never read.
 */
export function onboardingCandidates(db: Database, user: User, now = Date.now()): string[] {
  const since = new Date(Math.max(Date.parse(ONBOARDING_SINCE), now - ONBOARDING_WINDOW_MS)).toISOString();
  return db
    .query<{ repo_id: string }, [string, string, string]>(
      `SELECT a.repo_id FROM app a JOIN repo r ON r.id = a.repo_id
       WHERE r.owner_id = ?1 AND r.archived_at IS NULL AND a.created_at >= ?2
         AND NOT EXISTS (SELECT 1 FROM run d WHERE d.repo_id = a.repo_id AND d.kind = 'deploy'
                         AND d.env = 'production' AND d.serving_at IS NOT NULL AND d.serving_at < ?3)`,
    )
    .all(user.id, since, new Date(now - LIVE_SAID_MS).toISOString())
    .map((r) => r.repo_id);
}

export interface OnboardedNotice {
  readonly line: string;
  readonly items: readonly string[];
  readonly link: string;
}

/**
 * What the notifier last judged per app, kept until a run or pull event on
 * that app (`forgetOnboarding`), so a clock tick reads no pulls or runs.
 * `null` is "nothing to tell".
 */
const noticeCache = new WeakMap<Database, Map<string, OnboardedNotice | null>>();

/** A run or pull moved on this repository: judge its notice afresh next time. */
export function forgetOnboarding(db: Database, repoId: string): void {
  noticeCache.get(db)?.delete(repoId);
}

function onboardedNotice(db: Database, user: User, repoId: string, now: number): OnboardedNotice | null {
  const repo = getRepoById(db, repoId);
  const record = getAppByRepo(db, repoId);
  if (repo === undefined || record === undefined) return null;
  const base = `/${repo.ownerName}/${repo.name}`;
  // The owner may read every log; the notice never quotes one anyway.
  const line = onboardingLine(onboardingFacts(db, repo, record, base, user, true, now));
  if (line?.state === "live") return { line: `${repo.name} is live.`, items: [`onboarded:${repoId}:live`], link: `${base}/app` };
  if (line?.state === "stopped")
    return { line: `${repo.name} needs you: ${line.text}`, items: [`onboarded:${repoId}:stopped`], link: line.href ?? `${base}/app` };
  return null;
}

/**
 * What the owner is told, once per app: it went live, or it truly needs
 * them (the crew's pull closed without landing). A failed check or a retry
 * is never one: the id is the app and the outcome, so every retry in
 * between is the same silence.
 */
export function onboardedLines(db: Database, user: User, now = Date.now()): OnboardedNotice[] {
  if (user.kind !== "user") return [];
  const cache = noticeCache.get(db) ?? new Map<string, OnboardedNotice | null>();
  noticeCache.set(db, cache);
  const out: OnboardedNotice[] = [];
  for (const repoId of onboardingCandidates(db, user, now)) {
    let notice = cache.get(repoId);
    if (notice === undefined) {
      notice = onboardedNotice(db, user, repoId, now);
      cache.set(repoId, notice);
    }
    if (notice !== null) out.push(notice);
  }
  return out;
}
