import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/fleet/rows",
  summary: "The rows a fleet query line selects, as /fleet shows them, only those the caller may read; answers { kind, columns, items }",
  auth: false,
  query: { q: "string", sort: "string" },
  refusals: {
    invalid_query: "q is empty, over 500 characters, or does not parse; the reason is the message (422)",
    invalid_sort: "sort is not a column of the kind (422)",
  },
  reply: { kind: "string", columns: "array", items: "array" },
};
