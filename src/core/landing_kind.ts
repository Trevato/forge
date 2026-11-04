/**
 * How a pull lands, by where it came from. A fork someone keeps lands as a
 * true merge commit: its commits stay ancestors of main, each author keeps
 * their name, and the owner's next `git merge` of main is clean or a
 * fast-forward. Squashed, a long fork would conflict with its own code on
 * every pull back. A crew pull, or one made inside this repository, squashes.
 */

import type { Database } from "bun:sqlite";
import { getRepoById } from "./repos.ts";
import { getUserById } from "./users.ts";
import type { Pull } from "./pulls.ts";
import type { MergeStrategy } from "../git/merge.ts";

/** A fork a person keeps proposed this pull: cross-repo, and no agent wrote or owns it. */
export function fromKeptFork(
  db: Database,
  pull: Pick<Pull, "crossRepo" | "headRepoId" | "authorId">,
): boolean {
  if (!pull.crossRepo) return false;
  if (getUserById(db, pull.authorId)?.kind === "agent") return false;
  const head = getRepoById(db, pull.headRepoId);
  if (head === undefined) return false;
  return getUserById(db, head.ownerId)?.kind !== "agent";
}

/** The strategy a pull lands with: a kept fork's is always a merge, whatever was asked. */
export function landingKind(
  db: Database,
  pull: Pick<Pull, "crossRepo" | "headRepoId" | "authorId">,
  asked: MergeStrategy,
): MergeStrategy {
  return fromKeptFork(db, pull) ? "merge" : asked;
}
