import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/pulls/{number}/review-states`,
  summary: "List a pull's reviews, the verdicts (approved, changes_requested or commented), each with its body",
  auth: false,
};
