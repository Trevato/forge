import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/settings",
  summary:
    "Read the forge's signup mode, account quotas and own source repository (a person admin's token, any scope); answers { quotas, signup, forgeRepo, forgeRepoInForce, signupChanges, changes }",
  auth: true,
  refusals: { not_found: "the token is not a person who administers the forge" },
};
