import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/tokens",
  summary: "List your own tokens; a bearer token is refused with 403, call it from a browser session or with a password",
  auth: false,
  refusals: { forbidden: "the caller holds a bearer token, which cannot manage tokens" },
};
