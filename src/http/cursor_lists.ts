/** The one guard for `?page=` and `?offset=`: a list the contract says pages by `cursor` refuses them, so no handler can forget (#8386). */

import { pagesByCursor, ROUTES } from "../contract/openapi.ts";
import { apiError } from "./respond.ts";

export const PAGE_PARAM_SAYS = "This list pages by cursor: pass next_cursor as ?cursor=.";

/** The router pattern of a contract path: `{owner}` is `:owner`. */
const patternOf = (path: string): string => path.replace(/\{(\w+)\}/g, ":$1");

const CURSOR_LISTS: ReadonlySet<string> = new Set(
  ROUTES.filter(pagesByCursor).map((r) => patternOf(r.path)),
);

/** True when the caller paged the way most APIs do (`?page=` or `?offset=`). */
export function pagedByNumber(q: URLSearchParams): boolean {
  return q.has("page") || q.has("offset");
}

/** A 400 when this route pages by cursor and the query pages by number; undefined otherwise. */
export function pageParamRefused(pattern: string, q: URLSearchParams): Response | undefined {
  return CURSOR_LISTS.has(pattern) && pagedByNumber(q) ? apiError("invalid_query", 400, PAGE_PARAM_SAYS) : undefined;
}
