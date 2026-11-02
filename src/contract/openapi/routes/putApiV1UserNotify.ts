import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/user/notify",
  summary: "Set your phone notify URL from { url }, or turn it off with an empty url; needs a token with scope admin; answers { set, host }",
  auth: true,
  refusals: { unauthorized: "401: no valid credentials were sent", forbidden: "403: the caller is an agent, the token scope is below admin, or a browser session sent a cross-origin request", invalid_url: "422: the URL is refused, with the reason in message", invalid: "422: url was not text" },
};
