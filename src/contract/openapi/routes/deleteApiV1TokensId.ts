import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/tokens/{id}",
  summary: "Revoke one of your tokens; a bearer token is refused with 403, call it from a browser session or with a password; answers 204",
  auth: false,
  role: "member",
  status: 204,
  refusals: { forbidden: "the caller holds a bearer token, which cannot manage tokens" },
};
