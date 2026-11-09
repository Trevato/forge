import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/forge/economics",
  summary: "The profit slider: position (0 cheapest to 100 most responsive), marginPct, the policy the position means (sleep windows in ms, idle-pull window, cloud spill share; null is never), placement (whether a cloud body takes bursts, the owned-node label, in words), the operator's prices in US dollars, this UTC month's cost so far ({ owned, cloud, storage, crew, total } in USD) and the last changes (a person admin's token)",
  auth: true,
  refusals: {
    not_found: "the token is not a person who administers the forge (404)",
    not_admin: "the person's role may not administer the forge (403)",
  },
};
