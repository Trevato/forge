import { BROWSE, BROWSE_CODE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/tree/{ref}`,
  summary: "List the entries at the root of a ref of a repository the origin holds, live (the connecting user only); answers { type: \"dir\", ref, path, entries: [{ mode, type, oid, size, name }] }",
  auth: true,
  role: "member",
  refusals: BROWSE_CODE_REFUSALS,
};
