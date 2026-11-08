/**
 * The one filter every surface of the feed runs: what a viewer's chips
 * switch off. A kind chip names the kinds it covers and a person chip one
 * actor; an item that matches neither stays, whatever else it is.
 */

import { type Chips, type KindChip } from "../core/feed_chips.ts";
import type { FeedKind } from "./items.ts";

/** Which chip covers a kind of post; the rest (runs, costs, maps…) have none. */
const CHIP_OF: Partial<Record<FeedKind, KindChip>> = {
  pull: "reviews",
  decision: "decisions",
  choose: "decisions",
  tell: "crew",
  reply: "crew",
  look: "crew",
  release: "releases",
};

export const chipOfKind = (kind: FeedKind): KindChip | undefined => CHIP_OF[kind];

/** Whether the viewer's chips switch this item off. */
export function chipHides(
  chips: Chips,
  item: { readonly kind: FeedKind; readonly actorId: string | null },
): boolean {
  const chip = CHIP_OF[item.kind];
  if (chip !== undefined && chips.kinds.has(chip)) return true;
  return item.actorId !== null && chips.people.has(item.actorId);
}

/** How many of the posts on the page each kind chip covers: what pressing it would take away. */
export function chipCounts(items: readonly { readonly kind: FeedKind }[]): Map<KindChip, number> {
  const counts = new Map<KindChip, number>();
  for (const item of items) {
    const chip = CHIP_OF[item.kind];
    if (chip !== undefined) counts.set(chip, (counts.get(chip) ?? 0) + 1);
  }
  return counts;
}
