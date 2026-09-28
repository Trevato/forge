/**
 * Forks that follow their parent, asked for by hand. The following itself
 * happens as pushes land (`core/following.ts`); this is the same step on
 * request, with the answer when it cannot be done — the relationship
 * itself, read for whoever may read the fork, and `forkDrift`, what a
 * surface says before either happens.
 */

import type { App } from "../app.ts";
import {
  fastForwardFork,
  forkRelation,
  takeUpdates as take,
  type ForkRelation,
  type ForkSync,
  type TakeError,
} from "../core/following.ts";
import { canRead, getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { divergence } from "../git/branches.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { err, type Result } from "../kernel/result.ts";
import { requireWriter, type AccessError } from "./access.ts";

export type { ForkRelation, ForkSync, TakeError } from "../core/following.ts";

export type SyncForkError = AccessError | "not_a_fork" | "diverged";

function parentOf(app: App, fork: Repo): Repo | undefined {
  return fork.forkParentId === null
    ? undefined
    : getRepoById(app.db, fork.forkParentId);
}

/** Bring a fork's default branch up to its parent's, if nothing was committed on it. */
export async function syncFork(
  app: App,
  actor: User | undefined,
  fork: Repo,
): Promise<Result<ForkSync, SyncForkError>> {
  const writer = requireWriter(app, actor, fork);
  if (!writer.ok) return writer;
  const parent = parentOf(app, fork);
  if (parent === undefined) return err("not_a_fork");
  return fastForwardFork(app, fork, parent, writer.value.id);
}

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
  const parent = parentOf(app, fork);
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
  const parent = parentOf(app, fork);
  if (parent === undefined) return err("not_a_fork");
  const who = writer.value;
  return take(app, fork, parent, {
    id: who.id,
    name: who.displayName || who.username,
    email: who.email,
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
