import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/usage`,
  summary: "What the crew's runs here spent over a window, the owner's own facts: { app, days, since, total, bySubscription, byAgent, byIssue, recent, standing, spend, guard }; days 1 to 90; 403 to a reader who cannot write",
  auth: true,
  role: "member",
  query: { days: "integer" },
  refusals: { invalid_days: "days is not a whole number from 1 to 90" },
};
