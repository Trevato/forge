import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/boards/pins",
  summary: "Pin, unpin or move a board's panel on home; answers the new pins",
  auth: true,
  role: "admin",
  body: { op: "string", slug: "string", title: "string", by: "integer" },
  refusals: {
    bad_json: "the body is not a JSON object (400)",
    invalid: "`op` is not pin, unpin or move (422)",
    too_many: "there are too many pins (422)",
    not_a_panel: "slug and title name no panel (422)",
    not_found: "no such board",
  },
};
