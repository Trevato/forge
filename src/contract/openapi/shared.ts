/**
 * What every route file under `routes/` is made of: the `Route` row, and the
 * bodies, queries and refusals several routes share. A value only one route
 * uses lives in that route's file.
 */

import { LIST_LIMIT_MAX } from "../../core/issues.ts";

/** A plain type name, or an integer with the bounds its handler refuses outside of (`min`/`max` become `minimum`/`maximum`). */
export type QueryType = string | { readonly type: "integer"; readonly min?: number; readonly max?: number };

/** A `limit` from 1 to `max`, the constant its handler uses; no `max` when the handler has no upper bound. */
export const limitTo = (max?: number): QueryType => (max === undefined ? { type: "integer", min: 1 } : { type: "integer", min: 1, max });

export interface Route {
  readonly method: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
  readonly summary: string;
  /** Whether it needs a token; reads of public things do not. */
  readonly auth: boolean;
  /** A JSON body's fields, when it takes one. */
  readonly body?: Readonly<Record<string, string>>;
  /** The query parameters its handler reads, by name and type; an integer may carry the bounds its handler enforces. */
  readonly query?: Readonly<Record<string, QueryType>>;
  /** The success status, when it is not 200. */
  readonly status?: number;
  /** Other success statuses it answers, when a flag in the request changes it. */
  readonly alsoStatus?: readonly number[];
  /** The success body's fields, by name and type, when it is worth a schema. */
  readonly reply?: Readonly<Record<string, string>>;
  /** The refusals it answers, by stable `error` code. */
  readonly refusals?: Readonly<Record<string, string>>;
}

/** What `listQuery` in `http/api.ts` reads from a list of issues or pulls. */
export const LIST_QUERY = { state: "string", limit: limitTo(LIST_LIMIT_MAX), cursor: "integer", label: "string", author: "string" };

/** What the label routes for issues and pulls refuse by stable `error` code. */
export const LABEL_REFUSALS = {
  unknown_label: "a name or id in the set names no label of the repository",
  forbidden: "the caller cannot write to the repository",
  mirrored: "the repository mirrors an origin; do it there",
  origin_owner_only: "only the person who connected the origin can write through it",
  origin_unreachable: "the origin could not be reached (502)",
  origin_refused: "the origin refused the change (409)",
};

export const REPO = "/api/v1/repos/{owner}/{name}";

/** Browsing a repository the caller's origin holds; `{id}` is the origin. */
export const BROWSE = "/api/v1/user/origins/{id}/browse/{owner}/{name}";
export const BROWSE_LIST_QUERY = { state: "string", label: "string", author: "string", q: "string", cursor: "string" };
export const BROWSE_REFUSALS = {
  unauthorized: "401: no signed-in account",
  forbidden: "403: a cross-origin browser request, or a token without admin scope",
  not_found: "404: no such origin of yours, or the origin has no such repository, issue or pull",
  rate_limited: "429: the origin is rate-limiting this forge",
  origin_unauthorized: "502: the origin refused this forge's credential; reconnect it",
  origin_unreachable: "502: the origin could not be reached",
};

/** The refusals every live browse of an origin's code can answer (`sourceFailure` in `http/api/user.ts`); the connecting user only. */
export const BROWSE_CODE_REFUSALS = {
  ...BROWSE_REFUSALS,
  not_found: "404: no such origin of yours, or the origin has no such repository, ref or path",
};
