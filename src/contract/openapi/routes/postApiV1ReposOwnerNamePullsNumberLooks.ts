import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/pulls/{number}/looks`,
  summary: "Attach a look to a pull: a base64 picture at a stated width with a line saying what it shows (rw scope); answers 201 with { id, width, says, by, commit, url }",
  auth: true,
  status: 201,
  body: { width: "string", says: "string", image: "string" },
  refusals: {
    too_large: "the picture is over the size cap (413)",
    not_open: "the pull is closed or merged (409)",
    no_app: "the repository has no app to look at (409)",
    bad_image: "`image` is not an acceptable picture (422)",
    bad_note: "`says` is not acceptable (422)",
    bad_width: "`width` is not one the forge takes (422)",
  },
};
