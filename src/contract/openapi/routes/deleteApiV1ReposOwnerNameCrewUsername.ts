import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: `${REPO}/crew/{username}`,
  summary: "Take an agent off the repository's crew (admin scope, a repository admin's); answers {}",
  auth: true,
  role: "member",
  refusals: { no_such_agent: "`username` names no one on the crew" },
};
