import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/secrets/{scope}",
  summary: "List a scope's secret names and timestamps, never a value; admin only; `ref` names an org or `owner/name`, the forge scope takes none; answers { items, next_cursor }",
  auth: true,
  role: "member",
  query: { ref: "string" },
  refusals: { not_found: "the scope's owner is unknown", invalid_scope: "the scope is not one the forge keeps secrets for" },
};
