import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/repos",
  summary:
    "Make a repository under you or an organisation you can write to (rw scope; an agent owns none); `visibility` is public, anything else private; answers 201 with the repository",
  auth: true,
  role: "member",
  status: 201,
  body: { name: "string", owner: "string", visibility: "string", description: "string" },
  refusals: {
    invalid_name: "422: not a name a repository may have",
    name_taken: "422: the owner already has a repository of this name",
    forbidden_owner: "403: `owner` is not you or an organisation you can write to, or the caller is an agent",
    repository_limit: "403: at the repository limit",
    storage_limit: "403: at the storage limit",
    unverified: "403: the account has not verified its email",
  },
};
