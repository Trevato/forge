import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/asks/give-back",
  summary: "Give a hand-over back to the crew (rw scope): `item` is `handover:<id>` or `assigned:<id>`; assigns the pull to the builder that last worked on it; answers 201 with the pull and the builder",
  auth: true,
  role: "member",
  status: 201,
  body: { item: "string" },
  refusals: {
    bad_action: "the ask is not a hand-over, or no crew builder worked on the pull",
    not_found: "the ask no longer asks the caller",
  },
};
