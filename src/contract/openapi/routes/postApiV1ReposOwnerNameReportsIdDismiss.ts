import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/reports/{id}/dismiss`,
  summary: "Dismiss a waiting report (rw scope; a writer who is not on the crew); answers { id, state: \"dismissed\" }",
  auth: true,
  role: "member",
  refusals: {
    not_found: "no such repository or report, or not yours to decide",
    forbidden: "not a person who writes to the repository",
    decided: "the report was already accepted or dismissed (409)",
  },
};
