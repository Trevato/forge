import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/milestones/{number}/limb`,
  summary:
    "Act on a whole limb: defer, resume, close, raise, lower, replan or takeback. A dry run unless `dryRun` is false (ro scope); applied needs an admin token and answers 201 with the receipt, undone at /api/v1/fleet/ops/{id}/undo",
  auth: true,
  alsoStatus: [201],
  body: { action: "string", dryRun: "boolean", reason: "string", pillar: "string", under: "string" },
  refusals: {
    bad_action: "action is not defer, resume, close, raise, lower, replan or takeback (422)",
    not_found: "no such repository or milestone, or not yours to see",
    unauthorized: "no account",
    forbidden: "the caller may not act on this limb",
  },
};
