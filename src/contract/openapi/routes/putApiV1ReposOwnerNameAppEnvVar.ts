import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/app/env/{var}`,
  summary: "Set an environment variable (admin scope); the value is written and never read back; scope is all (default), production or preview",
  auth: true,
  role: "member",
  body: { value: "string", scope: "string" },
};
