import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/profile",
  summary:
    "Sample what the main thread is running for `seconds` (required, 1 to 30) (a person admin's token, any scope); answers { seconds, samples, note, stacks: [{ count, stack }] }",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge", busy: "a sample is already running" },
};
