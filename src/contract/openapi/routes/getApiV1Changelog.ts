import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/changelog",
  summary: "What went live and what is on its way, as /changelog shows it, for anyone: version, commit, live and onItsWay rows (repo, number, title, at, and for the forge's own landings by: who built it, with: the models and people its commit credits) of public repositories; ?repo=all|owner/name, this forge's own by default (all when it has none); carries a weak ETag of the live version, the chosen repo and the rows, and a repeat sending If-None-Match gets 304 with no body and the same ETag and cache-control",
  alsoStatus: [304],
  auth: false,
  role: "anonymous",
  query: { repo: "string" },
  refusals: {},
};
