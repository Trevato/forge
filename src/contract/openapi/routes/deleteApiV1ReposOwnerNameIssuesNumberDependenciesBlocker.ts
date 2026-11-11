import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: `${REPO}/issues/{number}/dependencies/{blocker}`,
  summary: "Stop an issue waiting for another",
  auth: true,
  role: "member",
};
