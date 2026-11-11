import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/forges/{name}/plan",
  summary: "Grant or change a child forge's plan by hand (a person admin's token, admin scope): active, source granted, kept in the audit trail. Answers { entitlement, changes }",
  auth: true,
  role: "admin",
  body: { plan: "small, medium or large" },
  refusals: { not_found: "the token is not a person who administers the forge (404)", no_such_forge: "no child forge has this name (404)", bad_plan: "plan is not small, medium or large (422)" },
};
