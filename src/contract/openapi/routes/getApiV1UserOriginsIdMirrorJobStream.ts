import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/origins/{id}/mirror/{job}/stream",
  summary: "Watch a mirror job live; answers text/event-stream, one event per stage (mirror.creating, mirror.fetching, mirror.labels, mirror.issues, mirror.pulls, mirror.comments, mirror.crew, mirror.done, mirror.failed) carrying the job, and ends after done or failed",
  auth: true,
  role: "member",
  refusals: { not_found: "404: no such origin or job of yours" },
};
