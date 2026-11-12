import { REPO, type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/forks`,
  summary:
    "List the forks of a repository you can read; answers { parent: \"owner/name\" | null, items: [...], next_cursor }, each item the repository plus ahead and behind (commits against the parent's default branch; null when git cannot say) and updatedAt (the last push, null when unknown), read for the page only; limit 1 to 200, cursor from next_cursor",
  auth: false,
  role: "anonymous",
  query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" },
  refusals: {
    invalid_limit: "limit is not a whole number from 1 to 200 (422)",
    invalid_cursor: "cursor is not the next_cursor of a page before, or names a row deleted since (422)",
  },
};
