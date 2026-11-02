import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/pinned/{name}/check",
  summary: "Read the droplet's public address back, probe the forge there, and say whether it answers; one that does is marked running",
  auth: true,
  refusals: {
    not_found: "only a forge administrator sees this route",
    refused: "the request was understood and refused; the message says why (422)",
  },
};
