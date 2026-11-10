import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/issues/{number}/dependencies`,
  summary: "What the issue waits for and what waits for it: { blockedBy, blocks }, each a list of { number, title, state, closeReason? }; issues the caller cannot see are left out",
  auth: false,
  role: "anonymous",
};
