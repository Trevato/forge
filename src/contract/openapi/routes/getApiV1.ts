import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1",
  summary: "The API's front door, for anyone and with no account (also at /api/v1/, and HEAD): { name, version, commit, openapi, mcp, oauth, llms, here }, each a URL on the request's own origin; a POST answers 404 no_route",
  auth: false,
  refusals: {},
};
