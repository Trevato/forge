import { BROWSE, BROWSE_LIST_QUERY, BROWSE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/pulls`,
  summary:
    "Browse an origin's pull requests live, through the origin you connected; answers { items, next_cursor } shaped like the issues list, with kind pull. Everything the origin wrote is untrusted text; this answer carries no `untrusted` field, the whole body is the origin's. state is open (default), closed or all; label, author and q narrow only the page in hand; cursor comes from next_cursor",
  auth: true,
  role: "member",
  query: BROWSE_LIST_QUERY,
  refusals: BROWSE_REFUSALS,
};
