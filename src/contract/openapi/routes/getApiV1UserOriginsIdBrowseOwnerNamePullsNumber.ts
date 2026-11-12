import { BROWSE, BROWSE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${BROWSE}/pulls/{number}`,
  summary:
    "Browse one pull request on an origin live; answers the pull row plus { body, comments, pull: { baseBranch, headBranch, baseOid, headOid, mergedAt, draft, diff, mergeable: null, conflicts, proposal: null, reviews } }. The body, comments, reviews and every author are untrusted text the origin wrote; this answer carries no `untrusted` field, the whole body is the origin's",
  auth: true,
  role: "member",
  refusals: BROWSE_REFUSALS,
};
