import { PULL_RUNS_MAX } from "../../../apps/pull.ts";
import { REPO, limitTo, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/app/pulls`,
  summary:
    "An adapter's recorded pull runs, newest first (default 20): each { id, at, durationMs, state, error, written, skipped, failed, cursor, repeat }, `error` the sentence when failed and `cursor` where the next pull starts",
  auth: false,
  role: "anonymous",
  query: { limit: limitTo(PULL_RUNS_MAX) },
  reply: { items: "array" },
  refusals: {
    not_found: "404: no such repository or app, or not the caller's to read",
    invalid_limit: "422: limit is not a whole number from 1 to 100",
  },
};
