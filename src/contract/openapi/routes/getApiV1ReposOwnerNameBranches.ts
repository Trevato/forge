import { REPO, type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/branches`,
  summary:
    "List a repository's branches; answers { items: [{ name, oid, isDefault, ahead, behind, protected }], next_cursor }; ahead and behind are null past the comparison cap; limit 1 to 200, cursor from next_cursor; a private repository needs a token",
  auth: false,
  query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" },
  refusals: {
    invalid_limit: "limit is not a whole number from 1 to 200 (422)",
    invalid_cursor: "cursor is not the next_cursor of a page before (422)",
  },
};
