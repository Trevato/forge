import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/fleet/graph",
  summary: "Spend and runs per repository by UTC hour (24 h) and day (14 d); `repo` (owner/name) repeats, else every repository the caller may write that spent lately",
  auth: true,
  role: "member",
  query: { repo: "string" },
  refusals: { invalid_selection: "`repo` is not a list of owner/name" },
};
