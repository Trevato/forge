import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/admin/invites/{id}",
  summary: "Revoke an invite link by id (admin scope); 404 when there is none",
  auth: true,
  role: "admin",
};
