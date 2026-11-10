import type { Route } from "../shared.ts";

const U = "no valid credentials were sent";
const F = "the credential is not the account: a session from another origin, or a token without admin scope";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/origins",
  summary: "List the forges (GitHub, Forgejo, Gitea) the caller has connected, never with a token; the caller's account only: a session, the password or an admin-scope token, any other token is a 403",
  auth: true,
  role: "member",
  refusals: { unauthorized: U, forbidden: F },
};
