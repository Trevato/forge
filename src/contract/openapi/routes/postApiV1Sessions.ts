import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/sessions",
  summary:
    "Sign in with a username and password: answers 201 with the account { id, username, displayName, isAdmin, commitEmail } and sets the HttpOnly forge_session cookie; refused from another origin with 403 forbidden",
  auth: false,
  role: "anonymous",
  status: 201,
  body: { username: "string", password: "string" },
  refusals: {
    unauthorized: "401, the username or password is wrong",
    too_many_attempts: "429, past the sign-in windows; retry-after says when",
    too_large: "413, the body is over the limit for a stranger's",
  },
};
