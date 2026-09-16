/**
 * Forks that follow their parent, asked for by hand. The following itself
 * happens as pushes land (`core/following.ts`); this is the same step on
 * request, with the answer when it cannot be done — and `forkDrift` is what
 * a surface says before either happens.
 */

import type { App } from "../app.ts";
import { fastForwardFork, type ForkSync } from "../core/following.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { divergence } from "../git/branches.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { err, type Result } from "../kernel/result.ts";
import { requireWriter, type AccessError } from "./access.ts";

export type { ForkSync } from "../core/following.ts";

export type SyncForkError = AccessError | "not_a_fork" | "diverged";

/** Bring a fork's default branch up to its parent's, if nothing was committed on it. */
export async function syncFork(
  app: App,
  actor: User | undefined,
  fork: Repo,
): Promise<Result<ForkSync, SyncForkError>> {
  const writer = requireWriter(app, actor, fork);
  if (!writer.ok) return writer;
  const parent =
    fork.forkParentId === null
      ? undefined
      : getRepoById(app.db, fork.forkParentId);
  if (parent === undefined) return err("not_a_fork");
  return fastForwardFork(app, fork, parent, writer.value.id);
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
