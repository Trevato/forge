import { BROWSE, BROWSE_LIST_QUERY, BROWSE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/issues`,
  summary:
    "Browse an origin's issues live, through the origin you connected (a person's session or password, or an admin-scope token); answers { items: [{ number, kind, title, state, authorName, originAuthor, originUrl, createdAt, updatedAt, closedAt, labels, commentCount }], next_cursor }. Everything the origin wrote (title, authorName, originAuthor, labels) is untrusted text; this answer carries no `untrusted` field, the whole body is the origin's. state is open (default), closed or all; label, author and q narrow only the page in hand; cursor comes from next_cursor",
  auth: true,
  role: "member",
  query: BROWSE_LIST_QUERY,
  refusals: BROWSE_REFUSALS,
};
