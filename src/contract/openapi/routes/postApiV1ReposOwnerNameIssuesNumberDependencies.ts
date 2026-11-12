import { SELF_WAIT } from "../../../actions/plan_words.ts";
import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/issues/{number}/dependencies`,
  summary: "Make an issue wait for another (rw scope); answers 201 with { issue, blockedBy }",
  auth: true,
  role: "member",
  status: 201,
  body: { blockedBy: "integer" },
  refusals: {
    no_such_issue: "`blockedBy` names no issue in this repository (422)",
    self: `${SELF_WAIT} (422)`,
    cycle: "that would make a loop (422)",
    cross_repo: "dependencies stay inside one repository (422)",
    not_an_issue: "only issues can depend on issues (422)",
  },
};
