import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/admin/plans",
  summary: "Replace the plans live (a person admin's token, admin scope); the next spawn and GET /api/v1/plans use them at once; answers { items }",
  auth: true,
  role: "admin",
  body: { plans: "list of { key, name, says, size, priceUsd, creditUsd, forges }; one to eight, `free` among them at $0" },
  refusals: {
    not_found: "the token is not a person who administers the forge (404)",
    invalid_plans: "a plan is not valid, named in the message (422)",
  },
};
