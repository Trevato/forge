import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/secrets/{scope}/{name}",
  summary: "Remove a secret by name (admin scope token); a value is never read back; answers {}",
  auth: true,
  role: "member",
  query: { ref: "string" },
  refusals: { not_found: "no such secret or scope owner", invalid_scope: "the scope is not one the forge keeps secrets for" },
};
