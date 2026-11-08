import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/proposal-tokens`,
  summary:
    "Hand a child its own narrow credential to propose pulls to this repository (rw scope; a writer's); answers 201 with the token, whose secret shows once",
  auth: true,
  status: 201,
  body: { child: "string", origin: "string", childRepo: "string" },
  refusals: {
    invalid_child: "child is not an acceptable name",
    invalid_origin: "origin is not an acceptable origin",
    too_large: "the body is over its byte limit (413)",
    not_found: "no such repository, or not one the caller writes to",
  },
};
