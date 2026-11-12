import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/maintenance/resume",
  summary: "End maintenance now: lift the release hold and let the crew start; needs an admin-scope token. The forge does this by itself at boot",
  auth: true,
  role: "admin",
  refusals: { not_found: "only a forge administrator may", conflict: "the forge is not in maintenance (409)" },
};
