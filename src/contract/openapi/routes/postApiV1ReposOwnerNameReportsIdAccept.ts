import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/reports/{id}/accept`,
  summary:
    "Accept a waiting report as an issue labelled outside (rw scope; a writer who is not on the crew); answers 201 with the issue; `title` rewords it, the marker stays",
  auth: true,
  role: "member",
  status: 201,
  body: { title: "string" },
  refusals: {
    not_found: "no such repository or report, or not yours to decide",
    forbidden: "not a person who writes to the repository",
    decided: "the report was already accepted or dismissed (409)",
    mirrored: "the repository mirrors an origin (409)",
  },
};
