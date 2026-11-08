import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: `${REPO}/issues/{number}`,
  summary: "Close or reopen an issue (state, with a reason and the issue it went into)",
  auth: true,
  body: { state: "string", reason: "string", into: "integer" },
  refusals: {
    forbidden:
      'Refused. A planner is told the rule: done needs an "already done on main" note naming commits on main; dropped is refused because a person\'s ask stands in the issue (split, replace or defer it); split needs open issues opened after the hand-over time it names; any other close is not the planner\'s. Any other caller is told its credentials lack the scope.',
  },
};
