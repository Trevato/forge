import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/app/{env}/redeploy`,
  summary: "Redeploy an environment (rw scope); answers 202 with { run }",
  auth: true,
  role: "member",
  status: 202,
};
