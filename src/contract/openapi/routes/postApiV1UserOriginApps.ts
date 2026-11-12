import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/user/origin-apps",
  summary: "Register an OAuth application for an origin host (a forgejo or gitea needs its own; github may fall back to the forge's); answers 201 with the application. The client secret is written here and never read back",
  auth: true,
  role: "member",
  body: { host: "string", kind: "string", clientId: "string", clientSecret: "string" },
  status: 201,
  reply: { id: "string", userId: "string", kind: "string", apiUrl: "string", webUrl: "string", clientId: "string", hasSecret: "boolean", createdAt: "string" },
  refusals: {
    unauthorized: "401: no signed-in account",
    forbidden: "403: a cross-origin browser request, or a token without admin scope",
    unknown_host: "422: that does not look like a forge host",
    private_host: "422: that address is inside a network, not on the internet",
    unreachable: "422: that host could not be reached",
  },
};
