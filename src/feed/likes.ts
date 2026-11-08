/**
 * Likes on feed items. A like is a `feed_like` row, one per person and item;
 * pressing again deletes it, so a person counts once however often they press.
 */

import type { Database } from "bun:sqlite";

export interface Likes {
  readonly likes: number;
  readonly liked: boolean;
}

/** Each item's like count and whether `viewerId` is among them; every asked item is answered. */
export function likesOf(
  db: Database,
  viewerId: string,
  itemIds: readonly string[],
): Map<string, Likes> {
  const out = new Map<string, Likes>(itemIds.map((i) => [i, { likes: 0, liked: false }]));
  if (itemIds.length === 0) return out;
  const rows = db
    .query<{ item_id: string; n: number; mine: number }, [string, string]>(
      `SELECT item_id, COUNT(*) AS n, SUM(viewer_id = ?2) AS mine FROM feed_like
        WHERE item_id IN (SELECT value FROM json_each(?1)) GROUP BY item_id`,
    )
    .all(JSON.stringify(itemIds), viewerId);
  for (const r of rows) out.set(r.item_id, { likes: r.n, liked: r.mine > 0 });
  return out;
}

/** The like pressed: liked becomes unliked and the other way round. Answers the state after. */
export function toggleLike(db: Database, viewerId: string, itemId: string, repoId: string): Likes {
  const gone = db.run("DELETE FROM feed_like WHERE viewer_id = ?1 AND item_id = ?2", [viewerId, itemId]);
  if (gone.changes === 0)
    db.run("INSERT INTO feed_like (viewer_id, item_id, repo_id) VALUES (?1, ?2, ?3)", [viewerId, itemId, repoId]);
  return likesOf(db, viewerId, [itemId]).get(itemId)!;
}
