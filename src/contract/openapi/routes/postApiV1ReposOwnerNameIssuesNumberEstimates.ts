import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/issues/{number}/estimates`,
  summary: "Record an estimate against an issue: event (pull_opened, merged, live), p50 and p90 instants, a one-line basis; the forge resolves and scores it",
  auth: true,
  role: "member",
  body: { event: "string", p50: "string", p90: "string", basis: "string" },
};
