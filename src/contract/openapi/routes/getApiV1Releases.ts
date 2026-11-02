import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/releases",
  summary: "The kept releases newest first, for the forge's administrators and its repository's readers; ?shipped=true is what went live and what is on its way, for anyone",
  auth: false,
  query: { shipped: "boolean" },
  refusals: {
    forbidden: "the release history is for the forge's administrators and its repository's readers",
    invalid_shipped: "shipped is true or absent (422)",
  },
};
