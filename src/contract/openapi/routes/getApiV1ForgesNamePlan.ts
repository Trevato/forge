import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/forges/{name}/plan",
  summary: "A child forge's entitlement ({ forge, plan, status, periodEnd?, source }; a forge never granted a plan is active on the plan its size names) and its last changes (a person admin's token)",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge (404)", no_such_forge: "no child forge has this name (404)" },
};
