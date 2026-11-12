import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/migrate/{job}/stream",
  summary:
    "Watch a migration job as an event stream (text/event-stream, not JSON): one `migrate.<stage>` event per stage with the job as data, closing after done or failed",
  auth: true,
  role: "member",
  refusals: { unauthorized: "401: no signed-in account", not_found: "404: no such job, or not the caller's" },
};
