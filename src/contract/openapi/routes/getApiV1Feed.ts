import { type Route, limitTo } from "../shared.ts";
import { FEED_LIMIT_MAX } from "../../../feed/feed.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/feed",
  summary: "The caller's own feed, newest first (ro scope; never cached); answers { items, next cursor } to pass back as `cursor`; `before=now` (then each `next_cursor` as `before`) reads the log newest first instead, one event id as cursor, a page costing the same at any depth, no repeat or skip when posts arrive; without a `cursor` it also carries `digest`, home's \"Since you were here\" card, `{ heading, lines: [{ repo, says, href }] }` or null (a page with a cursor has no `digest` key); reading never counts as a visit; the ETag moves with the digest",
  auth: true,
  role: "member",
  query: { limit: limitTo(FEED_LIMIT_MAX), cursor: "string", before: "string" },
  refusals: { invalid_limit: "limit is not a whole number from 1 to 50 (422)", invalid_cursor: "the cursor was not issued here (422)" },
};
