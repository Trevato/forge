import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/pulls/{number}/approve-here`,
  summary: "Let an origin fork's pull run here: a writer approves its current head (rw scope); answers 201",
  auth: true,
  role: "member",
  status: 201,
  refusals: {
    not_foreign: "the pull needs no approval to run (422)",
    self_review: "you cannot approve your own pull (422)",
    not_open: "the pull is closed (422)",
  },
};
