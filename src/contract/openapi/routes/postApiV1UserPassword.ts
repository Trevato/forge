import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/user/password",
  summary: "Change the caller's password: current is verified, next replaces it; answers 200 with {}. A person's password or an admin-scope token only",
  auth: true,
  role: "member",
  body: { current: "string", next: "string" },
  refusals: {
    unauthorized: "401: no signed-in account",
    forbidden: "403: a cross-origin browser request, or a token without admin scope",
    bad_credentials: "403: current is not the password",
    throttled: "429: too many wrong passwords from this address or for this name",
    weak_password: "422: next is shorter than the minimum",
    password_too_long: "422: next is longer than the cap",
  },
};
