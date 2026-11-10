import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/egress-grants`,
  summary: "Grant the app one egress destination (admin scope); answers 201 with the grant",
  auth: true,
  role: "member",
  status: 201,
  body: { destination: "string" },
  refusals: { invalid: "`destination` is not acceptable (422)" },
};
