import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/forges/{name}/claim-link",
  summary:
    "Make a new claim link for a forge nobody has claimed (a site admin's, rw scope); answers 201 with { name, claimUrl }. The link is shown once, here, and not again: the old link dies, so keep this one",
  auth: true,
  role: "admin",
  status: 201,
  refusals: { not_found: "no child forge has this name", forbidden: "the caller is not a site admin", claimed: "the forge is already claimed" },
};
