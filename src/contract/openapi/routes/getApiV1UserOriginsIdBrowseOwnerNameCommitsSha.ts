import { BROWSE, BROWSE_CODE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/commits/{sha}`,
  summary: "Read one commit of a repository the origin holds, live (the connecting user only): the commit's fields (oid, parents, author, email, date, subject, body, login?) with its diff",
  auth: true,
  role: "member",
  refusals: BROWSE_CODE_REFUSALS,
};
