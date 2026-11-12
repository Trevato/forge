import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/pulls/{number}/assignee`,
  summary: "Assign a pull to a person or crew member, or to no one with null (rw scope); answers the pull",
  auth: true,
  role: "member",
  body: { assignee: "string" },
  refusals: {
    invalid_assignee: "`assignee` is neither a username nor null (422)",
    no_such_user: "`assignee` names no account (422)",
  },
};
