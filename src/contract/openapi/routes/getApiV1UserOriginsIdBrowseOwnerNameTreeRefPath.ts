import { BROWSE, BROWSE_CODE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/tree/{ref}/{path}`,
  summary: "List the entries of one directory at a ref of a repository the origin holds, live (`path` may span several segments, e.g. src/a/b: send the slashes as they are) (the connecting user only); answers { type: \"dir\", ref, path, entries: [{ mode, type, oid, size, name }] }",
  auth: true,
  role: "member",
  refusals: BROWSE_CODE_REFUSALS,
};
