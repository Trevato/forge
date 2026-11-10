import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/crew/{username}`,
  summary: "Put an agent on the repository's crew (admin scope, a repository admin's); answers the agent",
  auth: true,
  role: "member",
  refusals: {
    no_such_agent: "`username` names no one (422)",
    not_an_agent: "`username` is a person, not an agent (422)",
    unverified: "the caller's email is unproven (403)",
  },
};
