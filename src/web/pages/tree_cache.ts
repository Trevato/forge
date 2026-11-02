/**
 * The rendered listing of one directory at one commit (#8199).
 *
 * A branch page costs a tree read, a ref list, the explorer's walk and the
 * README render, and strangers ask for the same few directories again and
 * again. For an anonymous reader of a public repository the markup depends
 * on nothing but the commit, the path and the ref spelled in the URL, so it
 * is kept under that key. The branch is resolved to its commit once, from the
 * ref files (no process); a push moves the branch, so the next request keys
 * on the new commit and the old entry simply ages out. The ref switcher's
 * menu is the one part a new branch elsewhere can change: it is at most
 * `TTL_MS` stale. Nothing here is truth: any entry can be dropped.
 */

import { isFullId } from "../../http/addressed.ts";
import { refTip } from "../../git/read.ts";
import { ViewCache } from "../../view/cache.ts";
import type { Html } from "../html.ts";

export const TTL_MS = 60_000;

export interface RenderedTree {
  readonly explorer: Html;
  readonly content: Html;
}

const cache = new ViewCache({ maxEntries: 512, maxBytes: 32 * 1024 * 1024 });

/** The commit `ref` names: a full id itself, a branch by its ref file; undefined for anything else (the caller reads git). */
export async function resolveCommit(dir: string, ref: string): Promise<string | undefined> {
  if (isFullId(ref)) return ref;
  return refTip(dir, `refs/heads/${ref}`);
}

const keyOf = (repoId: string, commit: string, ref: string, path: string, all: boolean): string =>
  [repoId, commit, ref, path, all ? "all" : "window"].join("\0");

export const cachedTree = (repoId: string, commit: string, ref: string, path: string, all: boolean) =>
  cache.get<RenderedTree>(keyOf(repoId, commit, ref, path, all));

export function keepTree(repoId: string, commit: string, ref: string, path: string, all: boolean, tree: RenderedTree): void {
  cache.set(keyOf(repoId, commit, ref, path, all), tree, TTL_MS, tree.explorer.text.length + tree.content.text.length);
}

export const treeCacheStats = () => cache.stats();

/** Test seam: start from nothing. */
export const clearTreeCache = (): void => cache.clear();
