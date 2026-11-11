import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/issues/{number}/teams`,
  summary: "Read the crew teams named on an issue; answers { teams }, a list of team slugs",
  auth: false,
  role: "anonymous",
};
