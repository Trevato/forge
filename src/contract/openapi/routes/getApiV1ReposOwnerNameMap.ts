import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/map`, summary: "Read the plan: issues, their dependency edges and pillars; `issues` and `edges` hold open issues only unless ?done=1, counts.done says how many are done; `startable` lists the ready, unassigned, unheld numbers; the 200 carries a weak etag of the facts served and the reader's sealed scope, cache-control private, no-cache and vary authorization, cookie, and a repeat sending If-None-Match gets 304 with no body while the map has not changed", auth: false, role: "anonymous", alsoStatus: [304],
  query: { done: "string" } };
