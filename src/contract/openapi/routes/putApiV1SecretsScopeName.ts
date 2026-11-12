import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/secrets/{scope}/{name}",
  summary: "Set a secret by name (admin scope, a site admin's); the value is write-only, the read never returns it; `ref` names an org or `owner/name`; answers the name and timestamps, never the value",
  auth: true,
  role: "member",
  body: { value: "string", ref: "string" },
  refusals: {
    invalid_name: "`name` is not an acceptable secret name (422)",
    invalid_value: "`value` is not acceptable (422)",
    invalid_scope: "the scope is not one the forge keeps secrets for (422)",
  },
};
