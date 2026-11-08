import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/drills",
  summary:
    "Each failure domain's last drill, as MCP `drills` says it (a person admin's token, any scope); answers { items: [{ key, breaks, drilled, why } or { key, breaks, drilled, drill, last: { at, green, why } | null, command }], next_cursor }",
  auth: true,
  refusals: { forbidden: "the token is not a forge admin who is a person" },
};
