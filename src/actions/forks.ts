/**
 * Forks that follow their parent, asked for by hand. The following itself
 * happens as pushes land (`core/following.ts`); this is the same step on
 * request, with the answer when it cannot be done — the relationship
 * itself, read for whoever may read the fork, and `forkDrift`, what a
 * surface says before either happens.
 */

import type { App } from "../app.ts";
import {
  forkRelation,
  takeUpdates as take,
  type ForkRelation,
  type ForkSync,
  type TakeError,
} from "../core/following.ts";
import {
  canRead,
  forkParentFor,
  type Repo,
} from "../core/repos.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import type { User } from "../core/users.ts";
import { divergence } from "../git/branches.ts";
import { runGit } from "../git/env.ts";
import { isSafeRef } from "../git/guard.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { err, type Result } from "../kernel/result.ts";
import { requireWriter, type AccessError } from "./access.ts";

export type { ForkRelation, ForkSync, TakeError } from "../core/following.ts";

/** The parent, while `actor` may read it (`forkParentFor`). */
const parentOf = (app: App, fork: Repo, actor: User | undefined) =>
  forkParentFor(app.db, fork, actor);

/**
 * Where the fork stands against its parent, for anyone who may read the
 * fork. A parent the reader may not see is still named — the relationship
 * is the fork's own fact — but nothing of its content travels.
 */
export async function relationOf(
  app: App,
  actor: User | undefined,
  fork: Repo,
): Promise<ForkRelation | undefined> {
  if (!canRead(app.db, fork, actor)) return undefined;
  const parent = parentOf(app, fork, actor);
  if (parent === undefined) return undefined;
  return forkRelation(app, fork, parent);
}

export type TakeUpdatesError = AccessError | "not_a_fork" | TakeError;

/**
 * Take the parent's updates: a fast-forward, or a merge commit when the
 * fork has work of its own and git merges cleanly. A conflict is refused
 * with the files, and is the crew's to converge.
 */
export async function takeUpdates(
  app: App,
  actor: User | undefined,
  fork: Repo,
): Promise<Result<ForkSync & { merged: boolean }, TakeUpdatesError>> {
  const writer = requireWriter(app, actor, fork);
  if (!writer.ok) return writer;
  const parent = parentOf(app, fork, actor);
  if (parent === undefined) return err("not_a_fork");
  const who = writer.value;
  return take(app, fork, parent, {
    id: who.id,
    ...commitIdentity(app.config, who),
  });
}

export interface ForkDrift {
  /** Commits the parent's default branch has that the fork's has not. */
  readonly behind: number | null;
  /** Commits the fork's default branch has of its own. */
  readonly ahead: number | null;
}

/**
 * How far a fork's default branch sits from its parent's — `behind` is what
 * an update would bring, `ahead` is what makes one impossible. A read, not a
 * mutation: no authorization, because the caller has already established it
 * may see the fork. The parent's objects reach the fork through its
 * alternates, so one `rev-list --left-right --count` in the fork answers
 * both halves; when it cannot (a detached fork, an empty branch) both are
 * null and a surface says nothing rather than guessing.
 */
export async function forkDrift(
  app: App,
  fork: Repo,
  parent: Repo,
): Promise<ForkDrift> {
  const forkDir = repoDir(app.reposRoot, fork.ownerName, fork.name);
  const parentDir = repoDir(app.reposRoot, parent.ownerName, parent.name);
  const head = await resolveOid(forkDir, `refs/heads/${fork.defaultBranch}`);
  const base = await resolveOid(
    parentDir,
    `refs/heads/${parent.defaultBranch}`,
  );
  if (head === undefined || base === undefined)
    return { ahead: null, behind: null };
  return divergence(forkDir, base, head);
}

// ---- ranking ----

export interface RankedFork {
  readonly fork: Repo;
  readonly drift: ForkDrift;
  /** When the fork's default branch last moved (ISO), or null. */
  readonly pushedAt: string | null;
}

/** Forks ranked in one page are bounded; each costs a git call. */
export const MAX_RANKED_FORKS = 60;

/**
 * Most work to offer first: commits ahead, then fewest behind, then the
 * newest push. A fork whose drift is unknown has nothing to offer and sorts
 * with the ones that are level.
 */
export function rankForks(forks: readonly RankedFork[]): {
  offering: RankedFork[];
  nothingNew: RankedFork[];
} {
  const newest = (f: RankedFork) => Date.parse(f.pushedAt ?? "") || 0;
  const order = (a: RankedFork, b: RankedFork) =>
    (b.drift.ahead ?? 0) - (a.drift.ahead ?? 0) ||
    (a.drift.behind ?? Infinity) - (b.drift.behind ?? Infinity) ||
    newest(b) - newest(a) ||
    a.fork.id.localeCompare(b.fork.id);
  const sorted = [...forks].sort(order);
  return {
    offering: sorted.filter((f) => (f.drift.ahead ?? 0) > 0),
    nothingNew: sorted.filter((f) => (f.drift.ahead ?? 0) === 0),
  };
}

/** What a fork's standing is worth saying: the words every surface uses. */
export const driftWords = (d: ForkDrift): string =>
  d.ahead === null || d.behind === null
    ? "standing unknown"
    : `${d.ahead} ahead · ${d.behind} behind`;

export const nothingNewHeading = (n: number): string =>
  `${n} fork${n === 1 ? "" : "s"} with nothing new`;

/**
 * A fork's standing is a pure function of the two tips, so it is kept by
 * them: a view whose forks have not moved costs one `git log` each and no
 * `rev-list`. Bounded; a full cache is emptied rather than tracked.
 */
const standing = new Map<string, ForkDrift>();
const STANDING_MAX = 2_000;

async function tipAndTime(
  dir: string,
  branch: string,
): Promise<{ oid: string; pushedAt: string | null } | undefined> {
  if (!isSafeRef(branch)) return undefined;
  const out = await runGit(
    ["log", "-1", "--format=%H %cI", `refs/heads/${branch}`],
    { cwd: dir },
  );
  if (!out.ok) return undefined;
  const [oid, at] = out.value.trim().split(" ");
  return oid === undefined || oid === ""
    ? undefined
    : { oid, pushedAt: at ?? null };
}

/** Each fork's drift from `parent` and its last push, read from git. */
export async function driftOfForks(
  app: App,
  parent: Repo,
  forks: readonly Repo[],
): Promise<RankedFork[]> {
  const base = await resolveOid(
    repoDir(app.reposRoot, parent.ownerName, parent.name),
    `refs/heads/${parent.defaultBranch}`,
  );
  return Promise.all(
    forks.slice(0, MAX_RANKED_FORKS).map(async (fork) => {
      const dir = repoDir(app.reposRoot, fork.ownerName, fork.name);
      const tip = await tipAndTime(dir, fork.defaultBranch);
      if (tip === undefined || base === undefined)
        return { fork, drift: { ahead: null, behind: null }, pushedAt: null };
      const key = `${base}:${tip.oid}`;
      let drift = standing.get(key);
      if (drift === undefined) {
        drift = await divergence(dir, base, tip.oid);
        if (standing.size >= STANDING_MAX) standing.clear();
        standing.set(key, drift);
      }
      return { fork, drift, pushedAt: tip.pushedAt };
    }),
  );
}

export interface ForkRanking {
  /** Every fork the viewer may read, ranked or not. */
  readonly total: number;
  readonly offering: RankedFork[];
  readonly nothingNew: RankedFork[];
  /** True when forks past `MAX_RANKED_FORKS` were left out of the ranking. */
  readonly truncated: boolean;
  /**
   * The repository is archived: no fork is counted against it, because a
   * frozen parent's "N ahead" reads as unshipped work (#7452). Every fork is
   * in `nothingNew`, with no drift, and a surface lists names only.
   */
  readonly archived: boolean;
}

/** The ranked forks of `repo` among those `mayRead`: one answer for every surface. */
export async function rankedForksOf(
  app: App,
  repo: Repo,
  forks: readonly Repo[],
): Promise<ForkRanking> {
  const truncated = forks.length > MAX_RANKED_FORKS;
  if (repo.archivedAt !== null) {
    const unmeasured = forks.slice(0, MAX_RANKED_FORKS).map((fork) => ({
      fork,
      drift: { ahead: null, behind: null },
      pushedAt: null,
    }));
    return { total: forks.length, offering: [], nothingNew: unmeasured, truncated, archived: true };
  }
  const ranked = rankForks(await driftOfForks(app, repo, forks));
  return { total: forks.length, ...ranked, truncated, archived: false };
}
