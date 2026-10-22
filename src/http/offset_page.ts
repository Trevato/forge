/** A list held whole in memory, served a page at a time: `limit` (1-200, 50 by default) and an opaque `cursor`. */

export const OFFSET_LIMIT_DEFAULT = 50;
export const OFFSET_LIMIT_MAX = 200;

export type OffsetQuery = { limit: number; offset: number } | { error: "invalid_limit" | "invalid_cursor" };

/** Read `?limit=&cursor=`; a bad value is named, never clamped. */
export function offsetQuery(q: URLSearchParams): OffsetQuery {
  const rawLimit = q.get("limit");
  const limit = rawLimit === null ? OFFSET_LIMIT_DEFAULT : /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : 0;
  if (limit < 1 || limit > OFFSET_LIMIT_MAX) return { error: "invalid_limit" };
  const rawCursor = q.get("cursor");
  if (rawCursor === null) return { limit, offset: 0 };
  if (!/^[1-9]\d{0,8}$/.test(rawCursor)) return { error: "invalid_cursor" };
  return { limit, offset: Number(rawCursor) };
}

export function offsetPage<T>(all: readonly T[], limit: number, offset: number): { items: T[]; next_cursor: string | null } {
  const end = offset + limit;
  return { items: all.slice(offset, end), next_cursor: end < all.length ? String(end) : null };
}
