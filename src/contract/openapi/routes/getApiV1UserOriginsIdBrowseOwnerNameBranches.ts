import { BROWSE, BROWSE_CODE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/branches`,
  summary: "List the branches of a repository the origin holds, live (the connecting user only); answers an array of { name, oid, isDefault, protected }",
  auth: true,
  role: "member",
  refusals: BROWSE_CODE_REFUSALS,
};
