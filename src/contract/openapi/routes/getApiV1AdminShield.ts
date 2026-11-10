import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/shield",
  summary: "The Shield's state (open, ceiling or signin) and its last change: who, when, from what to what (a forge admin's token)",
  auth: true,
  role: "admin",
  refusals: {
    not_found: "the token is not a forge admin (404)",
    not_admin: "the person's role may not administer the forge (403)",
  },
};
