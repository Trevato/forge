import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/user/origins/{id}/fork",
  summary: "Fork a repository at its origin, then mirror the fork as a job; answers 202 with { remote, existed, job, mirroredAs }",
  auth: true,
  role: "member",
  body: { fullName: "string" },
  status: 202,
  refusals: {
    not_found: "404: no such origin of yours",
    origin_unreachable: "422: the origin could not be reached",
    fork_timeout: "504: the origin took the fork and it has not appeared yet; try again shortly",
    mirror_failed: "502: a local copy of the fork could not be made",
  },
};
