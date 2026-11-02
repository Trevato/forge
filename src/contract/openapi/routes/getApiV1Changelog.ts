import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/changelog",
  summary: "What went live and what is on its way, as /changelog shows it, for anyone: version, commit, live and onItsWay rows (repo, number, title, at) of public repositories; ?repo=all|owner/name, this forge's own by default (all when it has none)",
  auth: false,
  query: { repo: "string" },
  refusals: {},
};
