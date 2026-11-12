import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/first-admin",
  summary:
    "Make the forge's first admin with the operator's one-time code, no session or password: answers 201 with { user, scope, id, token, expiresAt, expiresIn }, the token shown once; scope is ro, rw or admin; expiresIn is whole seconds from 60 to a month (default a day); refused from another origin with 403 forbidden",
  auth: false,
  role: "anonymous",
  status: 201,
  body: { code: "string", username: "string", email: "string", scope: "string", name: "string", expiresIn: "integer" },
  refusals: {
    too_large: "413, the body is over the limit for a stranger's",
    invalid_scope: "422, scope is not ro, rw or admin",
    invalid_expiry: "422, expiresIn is not whole seconds in range",
    rate_limited: "429, too many attempts from here; retry-after says when",
    refused: "403, the code does not work or this forge already has an admin",
    invalid_username: "422, not a name an account may have",
    invalid_email: "422, not an email address",
    username_taken: "422, another account has the name",
    email_taken: "422, another account has the address",
    username_reserved: "422, the name is reserved",
    unfinished: "422, the account could not be finished; send again",
  },
};
