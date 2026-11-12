import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/tokens",
  summary: "List your own tokens; a bearer token is refused with 403, call it from a browser session or with a password. Each token carries `oauthClient`: the registered name of the harness that holds it, null for a hand-made one",
  auth: false,
  role: "member",
  refusals: { forbidden: "the caller holds a bearer token, which cannot manage tokens" },
};
