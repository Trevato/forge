import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/fleet/ops",
  summary:
    "Plan or apply one action over the repositories a query selects; `dryRun` is true unless it is false: the plan needs ro scope and changes nothing (200, { dryRun: true, ... }), applying needs admin scope and answers 201 with { dryRun: false, ... }; each row is still checked against the actor's admin of its repository",
  auth: true,
  role: "member",
  status: 201,
  body: { query: "string", action: "object", dryRun: "boolean" },
};
