import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/pulls/{number}/review-states`,
  summary: "Submit a verdict on a pull (rw scope); answers 201 with the review; `comments` are line comments posted with it; a crew reviewer's approval may tick or leave boxes of the issues the pull closes (`ticks`, `left`)",
  auth: true,
  status: 201,
  body: { state: "string", body: "string", comments: "array", ticks: "array", left: "array" },
  refusals: {
    invalid_state: "`state` is not approved, changes_requested or commented (422)",
    invalid_comments: "`comments` is not a list of {path, line, side, body} (422)",
    invalid_boxes: "`ticks` is not a list of {issue, box} or `left` of {issue, box, why} (422)",
    self_review: "you cannot approve your own pull (422)",
    bad_anchor: "a comment's anchor is not in the diff; nothing was posted (422)",
    too_many_lines: "the review carries more line comments than the cap (422)",
  },
};
