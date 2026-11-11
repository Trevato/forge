import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/first-admin/recover",
  summary:
    "Get a stranded admin a new expiring token with the operator's recovery code; no account is made: answers 201 with { user, scope, id, token, expiresAt, expiresIn }; scope and expiresIn as for first-admin; refused from another origin with 403 forbidden",
  auth: false,
  role: "anonymous",
  status: 201,
  body: { code: "string", scope: "string", name: "string", expiresIn: "integer" },
  refusals: {
    too_large: "413, the body is over the limit for a stranger's",
    invalid_scope: "422, scope is not ro, rw or admin",
    invalid_expiry: "422, expiresIn is not whole seconds in range",
    rate_limited: "429, too many attempts from here; retry-after says when",
    refused: "403, the code does not work",
  },
};
