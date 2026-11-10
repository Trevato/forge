/**
 * A fork tree as plain data: an app's ancestors up to the root, then every
 * descendant of that root breadth-first, so siblings and cousins come free.
 *
 * Only what the caller may read is here. A fork they cannot read is left out
 * before anything is counted, and everything beneath it goes with it
 * (`visibleForks`, `forkParentFor`). An ancestor they cannot read ends the
 * climb: the root is the highest one they may see. No git is read.
 *
 * The repo asked about is always in `nodes`, however far below the root it sits
 * (its ancestors come with it, past `depth` and `limit` if need be). The cost
 * is one query per generation plus one for the follow modes, not per node.
 */

import type { Database } from "bun:sqlite";
import { forkFollowModes } from "../core/fork_follow.ts";
import { canRead, forkParentFor, visibleForksByParent, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";

/** Generations below the root shown when the caller does not say. */
export const DEFAULT_DEPTH = 4;
/** The most generations below the root any call may ask for. */
export const MAX_DEPTH = 8;
/** The most nodes any call returns; past it `truncated` is true. A page of a tree, not a crawl. */
export const MAX_NODES = 200;

/** How a node follows its parent: `offers` is the stored `tell-me`; the root of what is visible follows nothing. */
export type TreeFollow = "take-updates" | "offers" | "autonomous";

export interface TreeNode {
  readonly repo: string;
  readonly parent: string | null;
  /** Generations below the root; the root is 0. */
  readonly depth: number;
  readonly follow: TreeFollow;
}

export interface ForkTree {
  readonly root: string;
  readonly nodes: TreeNode[];
  readonly truncated: boolean;
}

const nameOf = (r: Repo): string => `${r.ownerName}/${r.name}`;

const clamp = (v: number | undefined, fallback: number, max: number): number =>
  v === undefined || !Number.isFinite(v) ? fallback : Math.min(max, Math.max(1, Math.floor(v)));

/** The tree around `repo`, or undefined when the caller may not read `repo` itself. */
export function forkTree(
  db: Database,
  repo: Repo,
  user: User | undefined,
  opts: { depth?: number; limit?: number } = {},
): ForkTree | undefined {
  if (!canRead(db, repo, user)) return undefined;
  const depth = clamp(opts.depth, DEFAULT_DEPTH, MAX_DEPTH);
  const limit = clamp(opts.limit, MAX_NODES, MAX_NODES);

  // Climb to the highest readable ancestor; `keep` is the path from there to `repo`.
  let root = repo;
  const keep = new Set<string>([repo.id]);
  for (;;) {
    const up = forkParentFor(db, root, user);
    if (up === undefined || keep.has(up.id)) break;
    keep.add(up.id);
    root = up;
  }
  // Generations to show: as asked, but never short of the repo itself.
  const reach = Math.max(depth, keep.size - 1);

  const rows: { repo: Repo; parent: Repo | null; depth: number }[] = [{ repo: root, parent: null, depth: 0 }];
  let truncated = false;
  const visited = new Set<string>([root.id]);
  let level: Repo[] = [root];
  for (let d = 1; d <= reach + 1 && level.length > 0; d++) {
    const by = visibleForksByParent(db, level, user);
    // One generation past the last shown is read only to know more exists.
    if (d > reach) {
      truncated = truncated || [...by.values()].some((kids) => kids.some((k) => !visited.has(k.id)));
      break;
    }
    const next: Repo[] = [];
    for (const parent of level) {
      for (const child of by.get(parent.id) ?? []) {
        if (visited.has(child.id)) continue;
        // A node on the path to `repo` is never cut: it is the one asked about.
        if (rows.length >= limit && !keep.has(child.id)) {
          truncated = true;
          continue;
        }
        visited.add(child.id);
        rows.push({ repo: child, parent, depth: d });
        next.push(child);
      }
    }
    level = next;
  }
  const modes = forkFollowModes(db, rows.slice(1).map((r) => r.repo.id));
  const nodes: TreeNode[] = rows.map((r) => ({
    repo: nameOf(r.repo),
    parent: r.parent === null ? null : nameOf(r.parent),
    depth: r.depth,
    follow: r.parent === null ? "autonomous" : modes.get(r.repo.id) === "take-updates" ? "take-updates" : "offers",
  }));
  return { root: nameOf(root), nodes, truncated };
}
