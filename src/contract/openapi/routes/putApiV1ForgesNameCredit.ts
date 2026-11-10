import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/forges/{name}/credit",
  summary:
    "Lend a child forge dollars of this forge's own model credential (a site admin's, rw scope). Body { usd } above 0 and up to 100000; answers { name, capUsd, spentUsd, says }. The child's crew calls the model through this forge, never holding the credential; every call is counted at list price and refused once the cap is spent. Raising the cap keeps what was spent. The list GET /api/v1/forges shows creditCapUsd and creditSpentUsd per child",
  auth: true,
  role: "admin",
  refusals: { not_found: "no child forge has this name", forbidden: "the caller is not a site admin", invalid: "usd is not dollars in range" },
};
