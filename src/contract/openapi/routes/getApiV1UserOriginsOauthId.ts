import type { Route } from "../shared.ts";

const U = "no valid credentials were sent";
const F = "the credential is not the account: a session from another origin, or a token without admin scope";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/origins/oauth/{id}",
  summary: "Poll an OAuth connect by its flowId until it is no longer pending (obey intervalSecs); answers the flow's status, and once connected the origin's id; the account only",
  auth: true,
  refusals: { unauthorized: U, forbidden: F, not_found: "no such flow among the caller's" },
};
