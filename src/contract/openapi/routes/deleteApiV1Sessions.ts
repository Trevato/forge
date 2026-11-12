import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/sessions",
  summary: "Sign out the session in the forge_session cookie: answers 200 with {} and clears the cookie; refused from another origin with 403 forbidden",
  auth: false,
  role: "anonymous",
};
