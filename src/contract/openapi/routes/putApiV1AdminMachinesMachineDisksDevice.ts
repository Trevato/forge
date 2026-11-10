import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/admin/machines/{machine}/disks/{device}",
  summary: "File a smartctl reading for one disk of a machine (a person admin's token, admin scope); answers 201",
  auth: true,
  body: { smartctl: "smartctl JSON, as text or object", cpu: "string, optional", memoryBytes: "integer, optional" },
  refusals: { invalid: "the reading does not parse (422)", not_found: "the token is not a person who administers the forge" },
};
