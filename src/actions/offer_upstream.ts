/**
 * A fork's commits, offered to its parent: plain data for every door. The
 * page draws a button from it and the terminal a key; both are gated the way
 * `openPull` gates a pull — a signed-in viewer who may read the parent — and
 * both find the open pull in the database, never in git.
 */

import type { App } from "../app.ts";
import { openPullFromHead } from "../core/pulls.ts";
import { canRead, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";

export interface UpstreamOffer {
  readonly ahead: number;
  /** The open pull already offering this branch, when there is one. */
  readonly openNumber: number | null;
  readonly head: string;
  readonly base: string;
}

/** `ahead` is the drift the caller has read; null or zero offers nothing. */
export function upstreamOffer(
  app: App,
  viewer: User | undefined,
  fork: Repo,
  parent: Repo | undefined,
  ahead: number | null | undefined,
): UpstreamOffer | null {
  if (parent === undefined || viewer === undefined) return null;
  // An archived parent takes nothing in; the fork's own work is not owed to it.
  if (parent.archivedAt !== null) return null;
  if (ahead === null || ahead === undefined || ahead <= 0) return null;
  if (!canRead(app.db, parent, viewer)) return null;
  const open = openPullFromHead(app.db, parent.id, fork.id, fork.defaultBranch);
  return {
    ahead,
    openNumber: open?.number ?? null,
    head: fork.defaultBranch,
    base: parent.defaultBranch,
  };
}
