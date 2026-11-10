import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/user/origins/{id}/mirror",
  summary: "Mirror a repository from one of your origins as a job; answers 202 with { job } to poll or stream",
  auth: true,
  role: "member",
  body: { fullName: "string", name: "string" },
  status: 202,
  refusals: { not_found: "404: no such origin of yours, or no such repository there" },
};
