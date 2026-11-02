import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/hooks`,
  summary:
    "List the repository's webhooks (admin scope), each without its secret; answers { items: [...], next_cursor }; limit 1 to 200, cursor from next_cursor",
  auth: true,
  query: { limit: "integer", cursor: "string" },
  refusals: {
    invalid_limit: "limit is not a whole number from 1 to 200 (422)",
    invalid_cursor: "cursor is not the next_cursor of a page before, or names a row deleted since (422)",
  },
};
