import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/user/pins/{owner}/{name}",
  summary: "Pin a repository you can read, again without harm; needs a token with scope rw or better; answers { pinned: true }",
  auth: true,
  refusals: { unauthorized: "401: no valid credentials were sent", forbidden: "403: the token scope is below rw, or a browser session sent a cross-origin request", not_found: "404: no such repository, or it is not readable by the caller" },
};
