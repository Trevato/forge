import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/accounts/{username}/end-sessions",
  summary: "Sign a person out of every browser (admin scope); body { dryRun? }; answers { username, sessionsEnded }",
  auth: true,
  role: "admin",
  refusals: { not_allowed: "the target is yourself or an agent, or another admin and you are not the forge's owner (422)" },
};
