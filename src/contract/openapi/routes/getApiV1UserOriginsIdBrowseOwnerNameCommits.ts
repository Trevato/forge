import { BROWSE, BROWSE_CODE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/commits`,
  summary: "List commits of a repository the origin holds, live, newest first (the connecting user only); answers { items: [{ oid, parents, author, email, date, subject, body, login? }], next_cursor }; ref defaults to the default branch",
  auth: true,
  role: "member",
  query: { ref: "string", cursor: "string" },
  refusals: BROWSE_CODE_REFUSALS,
};
