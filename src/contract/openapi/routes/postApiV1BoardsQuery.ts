import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/boards/query",
  summary: "Run one board query over every repository; answers { rows: [{ group, value, series? }] }",
  auth: true,
  role: "admin",
  body: { source: "string", from: "string", to: "string", filter: "array", groupBy: "object", step: "integer", aggregate: "string", column: "string", series: "string" },
  refusals: {
    bad_json: "the body is not JSON (400)",
    bad_query:
      "the query is refused (400): an unknown source (`unknown source: \"x\"`, see GET /api/v1/boards/sources), column, op, bucket or aggregate, a bad date, or too many points",
    too_large: "the body is too large (413)",
  },
};
