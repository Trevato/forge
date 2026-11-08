import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/maintenance/prepare",
  summary: "Prepare the forge for a power-off: hold releases, pause the crew, take a fresh backup, report the drain; needs an admin-scope token. Answers the status as GET does",
  auth: true,
  body: { reason: "string" },
  refusals: { not_found: "only a forge administrator may", invalid: "the reason is at most 200 characters (422)" },
};
