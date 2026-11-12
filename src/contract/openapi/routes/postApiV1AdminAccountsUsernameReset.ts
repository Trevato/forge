import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/accounts/{username}/reset",
  summary: "Make a person a one-time link, good for an hour, to set a new password and add a passkey (admin scope); body { endSessions?, dryRun? }; answers { username, url, expiresAt, sessionsEnded, mailed }",
  auth: true,
  role: "admin",
  refusals: { not_allowed: "the target is yourself or an agent, or another admin and you are not the forge's owner (422)" },
};
