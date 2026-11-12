import { BROWSE, BROWSE_CODE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/paths/{ref}`,
  summary: "List every file path at a ref of a repository the origin holds, live (the connecting user only); answers { paths, truncated }",
  auth: true,
  role: "member",
  refusals: BROWSE_CODE_REFUSALS,
};
