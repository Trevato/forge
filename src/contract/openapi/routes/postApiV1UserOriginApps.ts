import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/user/origin-apps",
  summary: "Register an OAuth application for an origin host (a forgejo or gitea needs its own; github may fall back to the forge's); answers 201 with the application",
  auth: true,
  body: { host: "string", kind: "string", clientId: "string", clientSecret: "string" },
  status: 201,
  refusals: {
    unknown_host: "422: that does not look like a forge host",
    private_host: "422: that address is inside a network, not on the internet",
    unreachable: "422: that host could not be reached",
  },
};
