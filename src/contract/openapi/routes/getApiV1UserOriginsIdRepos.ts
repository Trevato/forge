import type { Route } from "../shared.ts";

const U = "no valid credentials were sent";
const F = "the credential is not the account: a session from another origin, or a token without admin scope";
const NF = "no such origin among the caller's";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/origins/{id}/repos",
  summary: "With `group` (yours, shared, public), one live, searched page `{ items, next_cursor }` of that group. Without it, list the repositories an origin holds, from the cache unless `refresh=1` asks the origin again (a failed refresh falls back to the cache); pass an item's fullName to POST /api/v1/migrate as { source: { originId, fullName } }; the account only",
  auth: true,
  role: "member",
  query: { refresh: "string", group: "string", q: "string", cursor: "string" },
  refusals: {
    unauthorized: U,
    forbidden: F,
    not_found: NF,
    invalid_group: "422, group is yours, shared or public",
    origin_unreachable: "502, the origin could not be reached and nothing is cached",
  },
};
