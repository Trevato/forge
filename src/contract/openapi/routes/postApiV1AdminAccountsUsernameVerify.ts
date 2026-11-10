import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/accounts/{username}/verify",
  summary: "Mark an account's email verified by hand (admin scope); answers { username, verified: true }",
  auth: true,
  role: "admin",
  refusals: { not_allowed: "the target is an admin, an agent or yourself (422)" },
};
