import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/pulls/{number}/reviews`,
  summary: "Comment on one line of a pull's diff (rw scope); answers 201 with the comment; a verdict goes to …/review-states",
  auth: true,
  role: "member",
  status: 201,
  body: { path: "string", line: "integer", side: "string", body: "string" },
  refusals: { bad_anchor: "`path`, `line` and `side` (old or new) name no line of the pull's current diff (422)" },
};
