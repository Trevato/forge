/**
 * `limit`/`cursor` for an MCP list over rows already in key order, as the
 * routes they mirror page: `{ items, next_cursor }`, limit 1..200 (default
 * 50), and a cursor whose row is gone is `invalid_cursor`.
 */

import { bad, good, type Answer, type Args } from "./shared.ts";

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

export function pageRows<T>(rows: readonly T[], keyOf: (row: T) => string, args: Args): Answer {
  const rawLimit = args["limit"];
  const limit = rawLimit === undefined ? LIMIT_DEFAULT : rawLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX)
    return bad("invalid_limit", `limit is a whole number from 1 to ${LIMIT_MAX}`);
  const cursor = args["cursor"];
  let start = 0;
  if (cursor !== undefined) {
    const at = typeof cursor === "string" ? rows.findIndex((r) => keyOf(r) === cursor) : -1;
    if (at < 0) return bad("invalid_cursor", "cursor is the next_cursor of a page before");
    start = at + 1;
  }
  const items = rows.slice(start, start + limit);
  const more = start + limit < rows.length;
  return good({ items, next_cursor: more ? keyOf(items[items.length - 1]!) : null });
}
