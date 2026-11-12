import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/requests/{username}/allow",
  summary: "Allow a waiting request for an account (admin scope); answers the request as it now stands",
  auth: true,
  role: "admin",
  refusals: { not_waiting: "that request was answered already, or never waited (409)" },
};
