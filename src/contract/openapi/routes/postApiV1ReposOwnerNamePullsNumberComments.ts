import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/pulls/{number}/comments`,
  summary: "Comment on a pull (rw scope; anyone who may take part in the repository); answers 201 with the comment",
  auth: true,
  role: "member",
  status: 201,
  body: { body: "string" },
  refusals: {
    empty_body: "`body` is empty (422)",
    mirrored: "the repository mirrors an origin; comment there (409)",
  },
};
