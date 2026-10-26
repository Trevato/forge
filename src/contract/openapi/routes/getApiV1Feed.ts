import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/feed",
  summary: "The caller's own feed, newest first (ro scope; never cached); answers { items, next cursor } to pass back as `cursor`",
  auth: true,
  query: { limit: "integer", cursor: "string" },
  refusals: { invalid_limit: "limit is not a whole number from 1 to 50 (422)", invalid_cursor: "the cursor was not issued here (422)" },
};
