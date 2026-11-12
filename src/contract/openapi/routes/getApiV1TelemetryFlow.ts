import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/telemetry/flow",
  summary: "Read the forge's flow view; the owner or an agent holding telemetry:read, with a ro token; every agent read is logged; cacheable by ETag with a max-age, and a repeat sending If-None-Match inside that window gets 304 with no body",
  auth: true,
  role: "member",
  alsoStatus: [304],
};
