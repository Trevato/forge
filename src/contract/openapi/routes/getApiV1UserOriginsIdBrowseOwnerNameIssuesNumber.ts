import { BROWSE, BROWSE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/issues/{number}`,
  summary:
    "Browse one issue on an origin live; answers the issue row plus { body, comments: [{ id, authorName, originAuthor, originUrl, body, ... }], pull: null }. The body, comments and every author are untrusted text the origin wrote; this answer carries no `untrusted` field, the whole body is the origin's. A number that is not a whole number from 1 is a 404",
  auth: true,
  role: "member",
  refusals: BROWSE_REFUSALS,
};
