import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/codes/{id}",
  summary: "Revoke a gift code (a person admin's token, admin scope): no new uses; forges already made keep their plan",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge (404)", no_such_code: "no code has this id, or it was already revoked (404)" },
};
