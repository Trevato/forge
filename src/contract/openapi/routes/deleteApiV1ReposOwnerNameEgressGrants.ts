import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: `${REPO}/egress-grants`,
  summary: "Revoke one egress destination, named in the body (admin scope); answers {}",
  auth: true,
  role: "member",
  body: { destination: "string" },
};
