import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/branches`,
  summary:
    "Create a branch (rw scope), from `from` or the default branch; answers 201 with the branch",
  auth: true,
  role: "member",
  status: 201,
  body: { name: "string", from: "string" },
  refusals: {
    invalid_name: "name is not a branch name",
    unknown_start: "from names nothing in the repository",
    exists: "the branch is already there (409)",
    origin_refused: "a mirror's origin refused the branch",
  },
};
