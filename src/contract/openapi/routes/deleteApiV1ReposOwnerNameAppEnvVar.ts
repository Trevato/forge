import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: `${REPO}/app/env/{var}`,
  summary: "Unset an environment variable (admin scope); scope is all (default), production or preview; answers {}",
  auth: true,
  role: "member",
  query: { scope: "string" },
};
