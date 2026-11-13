import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/issues/{number}/estimates`,
  summary: "Read an issue's base rate from the forge's history (p50/p90 per event), the estimates recorded against it and the caller's scorecard",
  auth: true,
  role: "member",
};
