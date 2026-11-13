/**
 * Which green pulls can no longer be shipped as they stand: their head
 * conflicts with the base, or the base already holds everything they add.
 * Such a pull is not a person's decision — "ship it" cannot work — so the
 * asks (`web/studio/asks.ts`) leave it out until it merges again.
 *
 * Merging is git's to answer and costs a spawn, so it is learned off the
 * request path: a sweep over open pulls in repositories that ask a person,
 * remembered per database by the two tips it was answered between, so an
 * unchanged pull costs two ref reads and no merge. A derived cache, rebuilt
 * from git by the next sweep; an answer not yet known is no answer, and the
 * ask stands.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { joinMany, pullStatus } from "../core/pulls.ts";
import { getIssuesByIds } from "../core/issues.ts";
import { getRepoById } from "../core/repos.ts";
import { latestRunsForIssues } from "../core/runs.ts";
import { checkStale } from "../checks/stale.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";

interface Known {
  /** `head:base` — the tips this answer is about. */
  readonly between: string;
  /** The pull's head the answer was taken at, as the database names it. */
  readonly head: string;
  readonly stale: boolean;
  /** The base's tip when it was last read; empty when it could not be. */
  readonly base: string;
  /** The files that stop it merging; 0 when it merges or is simply already in. */
  readonly conflicts: number;
  /** When a sweep last saw it go from not merging to merging: its ask is new from then. */
  readonly mergesSince?: string;
}

const knownByDb = new WeakMap<Database, Map<string, Known>>();

const knownIn = (db: Database): Map<string, Known> => {
  let known = knownByDb.get(db);
  if (known === undefined) knownByDb.set(db, (known = new Map()));
  return known;
};

/** Whether this pull, at this head, was last found unable to merge as it stands. */
export function isStalePull(
  db: Database,
  pullId: string,
  headOid: string,
): boolean {
  const known = knownByDb.get(db)?.get(pullId);
  return known !== undefined && known.stale && known.head === headOid;
}

/**
 * Whether this pull's green was checked against an older tip of its base, as
 * the last sweep read that tip (#1179's `checkStale`). A tip not yet read is
 * no answer, and the green stands.
 */
export function staleGreen(
  db: Database,
  pull: { readonly id: string; readonly headOid: string },
  check: { readonly baseOid: string } | null | undefined,
): boolean {
  const known = knownByDb.get(db)?.get(pull.id);
  if (known === undefined || known.head !== pull.headOid) return false;
  return checkStale(check ?? null, known.base);
}

/**
 * How many files stop this pull, at this head, from merging, as the last
 * sweep found it: 0 when it merges, or when no sweep has answered yet.
 */
export function conflictsOf(
  db: Database,
  pullId: string,
  headOid: string,
): number {
  const known = knownByDb.get(db)?.get(pullId);
  return known !== undefined && known.head === headOid ? known.conflicts : 0;
}

/**
 * When this pull, at this head, last went from not merging to merging — a
 * new cause for its ask even with no new check, so a dismissal from before
 * no longer holds (`web/studio/asks.ts`). Undefined when it never did, or
 * when this process has not seen it happen.
 */
export function mergesAgainSince(
  db: Database,
  pullId: string,
  headOid: string,
): string | undefined {
  const known = knownByDb.get(db)?.get(pullId);
  return known !== undefined && !known.stale && known.head === headOid
    ? known.mergesSince
    : undefined;
}

/** The most pulls one sweep looks at: enough for a busy forge, bounded for a strange one. */
export const SWEEP_LIMIT = 300;

/**
 * Look again at every open pull with a green check in a repository that
 * asks a person (anything not `autonomous`: those settle their own). Never
 * throws; a pull git cannot answer for is left unknown.
 */
export async function sweepStaleAsks(app: App): Promise<void> {
  const db = app.db;
  const known = knownIn(db);
  const ids = db
    .query<{ id: string }, [number]>(
      `SELECT issue.id AS id FROM issue JOIN repo ON repo.id = issue.repo_id
       WHERE issue.kind = 'pull' AND issue.state = 'open'
       ORDER BY issue.updated_at DESC LIMIT ?1`,
    )
    .all(SWEEP_LIMIT)
    .map((r) => r.id);
  const checks = latestRunsForIssues(db, ids);
  const green = ids.filter((id) => checks.get(id)?.state === "ok");
  const pulls = joinMany(db, [...getIssuesByIds(db, green).values()]);
  const open = new Set(pulls.map((p) => p.id));
  for (const id of known.keys()) if (!open.has(id)) known.delete(id);
  for (const pull of pulls) {
    const repo = getRepoById(db, pull.repoId);
    if (!repo) continue;
    try {
      const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
      const base =
        (await resolveOid(dir, `refs/heads/${pull.baseBranch}`)) ?? "";
      const between = `${pull.headOid}:${base}`;
      if (known.get(pull.id)?.between === between) continue;
      // An autonomous repository settles its own mergeability; only the
      // base tip is read there, for the stale green.
      const status =
        repo.autonomy === "autonomous" ? undefined : await pullStatus(dir, pull);
      const stale =
        status !== undefined &&
        (status.ahead === 0 ||
          (!status.mergeable && status.conflicts.length > 0));
      const was = known.get(pull.id);
      const mergesSince =
        !stale && was?.stale === true && was.head === pull.headOid
          ? new Date().toISOString()
          : was?.head === pull.headOid
            ? was.mergesSince
            : undefined;
      known.set(pull.id, {
        between,
        head: pull.headOid,
        stale,
        base,
        conflicts:
          status === undefined || status.mergeable ? 0 : status.conflicts.length,
        ...(mergesSince === undefined ? {} : { mergesSince }),
      });
    } catch (error) {
      app.log.warn("stale-ask sweep skipped a pull", {
        pull: pull.number,
        error: String(error),
      });
    }
  }
}

/** What the last sweeps found of each pull, as plain data (one scope), and its adoption by a thread that does not sweep (`engine/observed.ts`). */
export const observedKnown = (db: Database): Map<string, unknown> => {
  const known = knownByDb.get(db);
  return known === undefined || known.size === 0 ? new Map() : new Map([["", [...known]]]);
};
export function adoptKnown(db: Database, value: unknown): void {
  if (value === undefined) knownByDb.delete(db);
  else knownByDb.set(db, new Map(value as [string, Known][]));
}
