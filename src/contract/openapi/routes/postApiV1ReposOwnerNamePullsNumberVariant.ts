import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/pulls/{number}/variant`,
  summary: "Like or dislike a pull among its variant siblings (rw scope and write access); a dislike closes the pull with a one-line reason; answers 201 with { answer, closed }",
  auth: true,
  role: "member",
  status: 201,
  body: { answer: "string", reason: "string" },
  refusals: {
    invalid_answer: "`answer` is not like or dislike (422)",
    not_variant: "the pull is not one of a set of variants (422)",
    not_open: "the pull is closed or merged (422)",
    failed: "the vote could not be recorded (422)",
  },
};
