import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/forks`,
  summary:
    "List the forks of a repository you can read; answers { items: [...], next_cursor }; limit 1 to 200, cursor from next_cursor",
  auth: false,
  query: { limit: "integer", cursor: "string" },
  refusals: {
    invalid_limit: "limit is not a whole number from 1 to 200 (422)",
    invalid_cursor: "cursor is not the next_cursor of a page before, or names a row deleted since (422)",
  },
};
