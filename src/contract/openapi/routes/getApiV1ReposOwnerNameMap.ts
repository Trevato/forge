import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/map`, summary: "Read the plan: issues, their dependency edges and pillars; `issues` and `edges` hold open issues only unless ?done=1, counts.done says how many are done; `startable` lists the ready, unassigned, unheld numbers", auth: false,
  query: { done: "string" } };
