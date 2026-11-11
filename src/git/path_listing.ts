/**
 * Every path at a ref, kept by the tree it names. A tree id is immutable, so
 * a kept listing is never stale: a branch that moves names a new tree and
 * misses. The tree is resolved on the repo's long-lived `cat-file
 * --batch-check` (no spawn); only a miss pays `ls-tree -r`.
 *
 * A listing is up to 50,000 paths (~2 MB), so few are kept: the hot case is
 * the same ref asked again, by a .sarif page reloaded or the file finder.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import type { GitFailure } from "./env.ts";
import { isSafeRef } from "./guard.ts";
import { listPaths, readerFor, type PathListing } from "./read.ts";

const MAX_KEPT = 8;
const kept = new Map<string, PathListing>();

export async function pathsAtTree(dir: string, ref: string): Promise<Result<PathListing, GitFailure | "missing">> {
  if (!isSafeRef(ref)) return err("missing");
  const tree = await readerFor(dir).stat(`${ref}^{tree}`);
  if (!tree.ok || tree.value.type !== "tree") return err("missing");
  const key = `${dir}\0${tree.value.oid}`;
  const hit = kept.get(key);
  if (hit !== undefined) {
    kept.delete(key);
    kept.set(key, hit);
    return ok(hit);
  }
  const listed = await listPaths(dir, tree.value.oid);
  if (!listed.ok) return listed;
  kept.set(key, listed.value);
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
  return listed;
}

/** How many listings are kept now; for tests. */
export function keptListings(): number {
  return kept.size;
}
