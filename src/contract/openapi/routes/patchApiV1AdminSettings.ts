import type { Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: "/api/v1/admin/settings",
  summary:
    "Change the signup mode (open, invite or closed) or the account quotas, one of the two per call (a person admin's token, admin scope); answers { signup } or { quotas }; a quota is a positive whole number, or null for no limit",
  auth: true,
  body: { signup: "string", quotas: "object" },
  refusals: {
    invalid_body: "neither signup nor quotas was sent, or both were",
    invalid_signup: "signup is not open, invite or closed",
    no_such_quota: "a quota key is unknown",
    invalid_quota: "a quota is not a positive whole number or null",
    not_found: "the token is not a person who administers the forge",
  },
};
