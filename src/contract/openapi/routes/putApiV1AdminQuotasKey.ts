import { QUOTA_KEYS } from "../../../settings/quotas.ts";
import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/admin/quotas/{key}",
  summary: `Set one per-account quota, or send value null or "" to clear it (a person admin's token, admin scope); {key} is one of ${QUOTA_KEYS.join(", ")}; answers { key, value, quotas }`,
  auth: true,
  role: "admin",
  body: { value: "positive integer, null or empty string" },
  refusals: {
    not_found: "the token is not a person who administers the forge (404)",
    no_such_quota: "{key} is not a quota (422)",
    invalid_quota: "the value is not a positive whole number (422)",
  },
};
