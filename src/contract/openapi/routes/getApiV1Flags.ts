import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/flags",
  summary:
    "Every declared flag with why it exists, its default, the issue that owns removing it and its live value, as MCP `flags` answers (a person admin's token); answers { flags }",
  auth: true,
  refusals: { forbidden: "the token is not a person who administers the forge" },
};
