import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/keeper",
  summary: "The release keeper's releases, holds and what blocks the next cut, for the forge's administrators and its repository's readers",
  auth: false,
  role: "anonymous",
  refusals: {
    forbidden: "the release history is for the forge's administrators and its repository's readers",
  },
};
