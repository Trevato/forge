import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/boards/{slug}/panels/{id}",
  summary:
    "Read one panel's rows; `id` is its place on the board from 0. Answers { board, panel, title, chart, rows, from, to, step }, or a CSV table with format=csv",
  auth: true,
  role: "admin",
  query: { format: "string", from: "string", to: "string", step: "string" },
  refusals: {
    invalid_format: "format is not json or csv (422)",
    invalid_window: "from, to or step is not a window (422)",
    bad_query: "the panel's query cannot run (400)",
  },
};
