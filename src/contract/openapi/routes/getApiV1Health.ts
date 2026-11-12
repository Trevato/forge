import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/health",
  summary: "How the forge is, uncached; anyone may ask, a stranger is told little, the release probe and a site admin the whole of it",
  auth: false,
  role: "anonymous",
};
