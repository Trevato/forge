import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/quotas",
  summary:
    "Read the per-account quotas (a person admin's token, any scope); answers { quotas: { repositories, apps, storage, previews, runs, checks }, changes }, each a number or null for none",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge" },
};
