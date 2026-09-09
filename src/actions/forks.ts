/**
 * Forks that follow their parent, asked for by hand. The following itself
 * happens as pushes land (`core/following.ts`); this is the same step on
 * request, with the answer when it cannot be done.
 */

import type { App } from "../app.ts";
import { fastForwardFork, type ForkSync } from "../core/following.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
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
