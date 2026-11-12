import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/returns",
  summary: "What the work returned over the last days, for the caller or one repository; never cached",
  auth: true,
  role: "member",
  query: { repo: "string", days: "integer" },
  refusals: { invalid_days: "days is not a whole number in range" },
};
