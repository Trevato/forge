import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/user/keys",
  summary: "Add an SSH public key (an authorized_keys line); needs a token with scope rw or better; answers 201 with the key",
  auth: true,
  role: "member",
  status: 201,
  body: { name: "string", key: "string" },
  refusals: { unauthorized: "401: no valid credentials were sent", forbidden: "403: the token scope is below rw, or a browser session sent a cross-origin request", invalid_key: "`key` is not a usable public key (422)", key_exists: "the key is already registered (422)" },
};
