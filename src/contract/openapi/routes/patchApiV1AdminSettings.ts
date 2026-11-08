import type { Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: "/api/v1/admin/settings",
  summary:
    "Change the signup mode (open, invite or closed), the account quotas, or the forge's own source repository (forgeRepo: owner/name, null to clear; its app is then shown as the forge itself), one per call (a person admin's token, admin scope); answers { signup }, { quotas } or { forgeRepo }; a quota is a positive whole number, or null for no limit",
  auth: true,
  body: { signup: "string", quotas: "object", forgeRepo: "string" },
  refusals: {
    invalid_body: "none of signup, quotas or forgeRepo was sent, or more than one was",
    invalid_forge_repo: "forgeRepo is not owner/name or null",
    invalid_signup: "signup is not open, invite or closed",
    no_such_quota: "a quota key is unknown",
    invalid_quota: "a quota is not a positive whole number or null",
    not_found: "the token is not a person who administers the forge",
  },
};
