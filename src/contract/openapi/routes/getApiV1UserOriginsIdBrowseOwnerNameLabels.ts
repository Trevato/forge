import { BROWSE, BROWSE_CODE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/labels`,
  summary: "List the labels of a repository the origin holds, live (the connecting user only); answers an array of { id, name, color }",
  auth: true,
  role: "member",
  refusals: BROWSE_CODE_REFUSALS,
};
