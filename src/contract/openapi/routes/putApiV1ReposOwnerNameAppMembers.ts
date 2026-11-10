import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/app/members`,
  summary: "Set the people a private app names (admin scope, a person's, never an agent's); a plan unless dryRun is false",
  auth: true,
  role: "member",
  body: { members: "array", dryRun: "boolean" },
  refusals: { invalid: "`members` is not a list of usernames" },
};
