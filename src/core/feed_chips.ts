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

/**
 * A filter given as arguments (`hide_kinds`, `hide_people`, the latter by
 * username): the chips it names, or why it is not one. Absent is undefined —
 * the viewer's saved chips stand; given, it replaces them for that call.
 */
export function parseChipArgs(
  args: { hide_kinds?: unknown; hide_people?: unknown },
  userId: (name: string) => string | undefined,
): Chips | undefined | { error: string } {
  const { hide_kinds: k, hide_people: p } = args;
  if (k === undefined && p === undefined) return undefined;
  const kinds = new Set<KindChip>();
  const people = new Set<string>();
  const list = (v: unknown): unknown[] | undefined =>
    v === undefined ? [] : Array.isArray(v) && v.length <= 50 ? v : undefined;
  const ks = list(k);
  const ps = list(p);
  if (ks === undefined || ps === undefined)
    return { error: "hide_kinds and hide_people are lists of at most 50" };
  for (const v of ks) {
    if (!isKindChip(v)) return { error: `hide_kinds are ${KIND_CHIPS.join(", ")}` };
    kinds.add(v);
  }
  for (const v of ps) {
    const id = typeof v === "string" ? userId(v) : undefined;
    if (id === undefined) return { error: "hide_people are usernames of people or agents here" };
    people.add(id);
  }
  return { kinds, people };
}
