import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: `${REPO}/branches/{branch}`,
  summary:
    "Delete a branch (rw scope); the name may hold slashes; answers 204 with no body",
  auth: true,
  role: "member",
  status: 204,
  refusals: {
    invalid_name: "not a branch name",
    default_branch: "the default branch cannot be deleted (409)",
    unknown_branch: "no such branch (404)",
    origin_refused: "a mirror's origin refused the deletion",
  },
};
