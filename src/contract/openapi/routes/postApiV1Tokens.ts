import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/tokens",
  summary: "Mint a token of scope ro, rw or admin; needs a browser session or a username and password, a bearer token is refused with 403; a site admin must send adminConfirm: true; answers 201 with the token once",
  auth: false,
  role: "member",
  status: 201,
  body: { name: "string", scope: "string", username: "string", password: "string", adminConfirm: "boolean" },
  refusals: {
    invalid_scope: "scope is not ro, rw or admin",
    admin_confirm: "a site admin did not send adminConfirm: true",
    forbidden: "a bearer token cannot mint tokens, or the account may not hold an admin token",
  },
};
