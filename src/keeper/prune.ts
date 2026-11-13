/**
 * Which stored releases go (#11801): the release step prunes its own old
 * images, or under the self-swap keeper its swapped-in trees, once a
 * release is verified live. It replaces `forge-prune-images`, a host timer
 * on pg-grand.
 *
 * Plain data in, a list to delete out: the stored releases with when each
 * was made, and the ones that must stay (the live release, the release's
 * named known-good). The newest {@link KEEP_NEWEST} stay too; everything
 * else is named, oldest first. Nothing here touches a disk or a registry.
 */

/** How many of the newest stored releases are kept, besides the live one and the known-good. */
export const KEEP_NEWEST = 15;

/** A stored release: its id in the store (a commit for a tree, a tag for an image) and when it was made, epoch ms. */
export interface Stored {
  readonly id: string;
  readonly at: number;
}

/** The ids to delete: all but the `newest` most recent, never one in `keep`. Oldest first. */
export function toPrune(found: readonly Stored[], keep: readonly string[], newest: number = KEEP_NEWEST): string[] {
  const limit = Math.max(1, Math.floor(Number.isFinite(newest) ? newest : KEEP_NEWEST));
  // One entry per id, at its newest.
  const latest = new Map<string, number>();
  for (const s of found) latest.set(s.id, Math.max(s.at, latest.get(s.id) ?? -Infinity));
  const ordered = [...latest].sort(([a, at], [b, bt]) => bt - at || (a < b ? -1 : a > b ? 1 : 0)).map(([id]) => id);
  const kept = new Set(keep);
  return ordered.slice(limit).filter((id) => !kept.has(id)).reverse();
}
