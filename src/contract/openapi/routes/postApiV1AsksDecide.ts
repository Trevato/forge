import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/asks/decide",
  summary: "Let the decider answer a hand-over ask (rw scope); answers 201 with a receipt naming an operation, to undo at /api/v1/asks/decide/{id}/undo",
  auth: true,
  role: "member",
  status: 201,
  body: { item: "string" },
  refusals: {
    bad_action: "the ask is not a hand-over, or no decider is set up on this forge (422)",
    not_found: "the ask no longer asks the caller",
    too_many: "the decider answered this a moment ago; try again in a few minutes (429)",
  },
};
