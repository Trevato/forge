import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/release/heartbeat",
  summary: "A release path outside the forge records one tick: outcome cut, skipped or failed, and a reason of at most 300 characters",
  auth: true,
  role: "admin",
  refusals: {
    forbidden: "a release heartbeat is recorded by the forge's administrators only",
    invalid_outcome: "outcome is cut, skipped or failed",
    invalid_reason: "reason is plain words, 1 to 300 characters",
  },
};
