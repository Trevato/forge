import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/timers/{key}",
  summary: "An app cancels its own pending one-shot timer by key, with its own token; answers 200; 404 when none is pending",
  auth: true,
  role: "member",
  refusals: { not_found: "404: no pending timer has that key", unauthorized: "401: not an app's own token" },
};
