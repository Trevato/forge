import { REPO, type Route, limitTo } from "../shared.ts";
import { DECISIONS_LIMIT_MAX } from "../../../core/decisions.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/decisions`,
  summary: "Page through the decision ledger as the caller may see it, newest first; `kind` is next, land, retry or guard; `limit` 1 to 100 (default 30), `cursor` is the next_cursor of the page before; answers { decisions, week, next_cursor }; a bad limit or cursor is a 422",
  auth: false,
  role: "anonymous",
  query: { kind: "string", limit: limitTo(DECISIONS_LIMIT_MAX), cursor: "string" },
};
