/**
 * The chips a viewer switched off: a kind of post (`reviews`, `decisions`,
 * `crew`, `releases`) or a person or agent (by user id). Saved per viewer,
 * beside their mutes; the feed, the home and the inbox read them through
 * one filter (`feed/chips.ts`). Pure data: the route owes the validation.
 */

import type { Database } from "bun:sqlite";

export const KIND_CHIPS = ["reviews", "decisions", "crew", "releases"] as const;
export type KindChip = (typeof KIND_CHIPS)[number];

export const isKindChip = (v: unknown): v is KindChip =>
  typeof v === "string" && (KIND_CHIPS as readonly string[]).includes(v);

/** What a viewer has switched off. */
export interface Chips {
  readonly kinds: ReadonlySet<KindChip>;
  readonly people: ReadonlySet<string>;
}

export const noChips: Chips = { kinds: new Set(), people: new Set() };

export function chipsOf(db: Database, viewerId: string): Chips {
  const kinds = new Set<KindChip>();
  const people = new Set<string>();
  for (const r of db
    .query<{ kind: string; value: string }, [string]>(
      "SELECT kind, value FROM feed_chip WHERE viewer_id = ?1",
    )
    .all(viewerId)) {
    if (r.kind === "person") people.add(r.value);
    else if (isKindChip(r.value)) kinds.add(r.value);
  }
  return { kinds, people };
}

/** Switch a chip off (`hidden`) or back on; twice is the same as once. */
export function setChip(
  db: Database,
  viewerId: string,
  chip: { kind: "kind" | "person"; value: string },
  hidden: boolean,
): void {
  if (hidden)
    db.query(
      "INSERT OR IGNORE INTO feed_chip (viewer_id, kind, value) VALUES (?1, ?2, ?3)",
    ).run(viewerId, chip.kind, chip.value);
  else
    db.query(
      "DELETE FROM feed_chip WHERE viewer_id = ?1 AND kind = ?2 AND value = ?3",
    ).run(viewerId, chip.kind, chip.value);
}
