import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/user/pins/{owner}/{name}",
  summary: "Unpin a repository; needs a token with scope rw or better; answers 204",
  auth: true,
  status: 204,
  refusals: { unauthorized: "401: no valid credentials were sent", forbidden: "403: the token scope is below rw, or a browser session sent a cross-origin request", not_found: "404: no such repository, or it is not readable by the caller" },
};
