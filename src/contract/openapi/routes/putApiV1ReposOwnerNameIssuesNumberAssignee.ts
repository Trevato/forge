import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/issues/{number}/assignee`,
  summary: "Assign an issue to a person or crew member, or to no one with null (rw scope); answers the issue",
  auth: true,
  role: "member",
  body: { assignee: "string" },
  refusals: {
    invalid_assignee: "`assignee` is neither a username nor null (422)",
    no_such_user: "`assignee` names no account (422)",
  },
};
