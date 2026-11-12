import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/origins/{id}/mirror/{job}",
  summary: "Read a mirror job's stage: { job }; stages run creating, fetching, labels, issues, pulls, comments, crew, then done or failed",
  auth: true,
  role: "member",
  refusals: { not_found: "404: no such origin or job of yours" },
};
