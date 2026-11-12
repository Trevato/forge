/**
 * Likes on feed items. `feed_like` is the current state, one row per person and item;
 * each act is also a ledger row (`feed_signal`), so a person counts once however often they press.
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

export type LikeAct = "like" | "unlike";

/**
 * Like or unlike, as one ledger row (`feed_signal`: who, what, when). Asking
 * for the state already held is a no-op that answers the same. The current
 * state (`feed_like`) moves in the same transaction; history is only added to.
 */
export function setLike(
  db: Database,
  viewerId: string,
  itemId: string,
  repoId: string,
  act: LikeAct,
): Likes {
  db.transaction(() => {
    const has = db.query("SELECT 1 FROM feed_like WHERE viewer_id = ?1 AND item_id = ?2").get(viewerId, itemId) !== null;
    if (has === (act === "like")) return false;
    db.run("INSERT INTO feed_signal (viewer_id, item_id, repo_id, act) VALUES (?1, ?2, ?3, ?4)", [viewerId, itemId, repoId, act]);
    if (act === "like") db.run("INSERT INTO feed_like (viewer_id, item_id, repo_id) VALUES (?1, ?2, ?3)", [viewerId, itemId, repoId]);
    else db.run("DELETE FROM feed_like WHERE viewer_id = ?1 AND item_id = ?2", [viewerId, itemId]);
    return true;
  })();
  return likesOf(db, viewerId, [itemId]).get(itemId)!;
}

/** The like pressed in the terminal: liked becomes unliked and the other way round. */
export function toggleLike(db: Database, viewerId: string, itemId: string, repoId: string): Likes {
  const liked = likesOf(db, viewerId, [itemId]).get(itemId)!.liked;
  return setLike(db, viewerId, itemId, repoId, liked ? "unlike" : "like");
}

export interface LedgerRow {
  readonly seq: number;
  readonly who: string;
  readonly item: string;
  readonly act: LikeAct;
  readonly at: string;
}

export const LEDGER_PAGE = 50;

export interface LedgerPage {
  readonly rows: LedgerRow[];
  /** True when older rows remain: ask again with `before` = the last row's `seq`. */
  readonly more: boolean;
}

/** One item's ledger, newest first, a page at a time; `before` is a `seq` to read the rows older than. */
export function likeLedger(db: Database, itemId: string, before?: number, limit = LEDGER_PAGE): LedgerPage {
  const rows = db
    .query<LedgerRow, [string, number, number]>(
      `SELECT s.seq, u.username AS who, s.item_id AS item, s.act, s.created_at AS at
         FROM feed_signal s JOIN user u ON u.id = s.viewer_id
        WHERE s.item_id = ?1 AND s.seq < ?2 ORDER BY s.seq DESC LIMIT ?3`,
    )
    .all(itemId, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

/** `before` from a query string or tool argument: a positive whole number, or undefined when absent; null when bad. */
export function parseLedgerBefore(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : /^\d{1,15}$/.test(String(raw)) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** What the ledger says an item's likes are: viewers whose last act on it is a like. */
export function ledgerCount(db: Database, itemId: string): number {
  return db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM feed_signal s
        WHERE s.item_id = ?1 AND s.act = 'like'
          AND s.seq = (SELECT MAX(seq) FROM feed_signal WHERE item_id = s.item_id AND viewer_id = s.viewer_id)`,
    )
    .get(itemId)!.n;
}
