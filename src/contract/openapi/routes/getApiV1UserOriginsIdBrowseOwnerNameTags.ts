import { BROWSE, BROWSE_CODE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/tags`,
  summary: "List the tags of a repository the origin holds, live (the connecting user only); answers an array of { name, oid, commit }",
  auth: true,
  role: "member",
  refusals: BROWSE_CODE_REFUSALS,
};
