import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/maintenance",
  summary: "Where planned maintenance stands: { phase: idle | draining | ready, since?, reason?, backup?, working, last?, says }; ready means releases are held, the crew is paused, a fresh backup is taken and nothing runs",
  auth: true,
  refusals: { not_found: "only a forge administrator sees this route" },
};
