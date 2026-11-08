import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/pulls/{number}/hold`,
  summary:
    "Hold an open pull (with until green, the forge releases it when a check passes on the pull's head) with one line that says why, so no rule reviews or lands it until it is released; a person who writes the repository holds, never an agent (rw scope); answers `{ held: true, hold }`",
  auth: true,
  body: { why: "string", until: "string" },
  refusals: {
    forbidden: "you are an agent, or you cannot write the repository (403)",
    not_open: "the pull is closed or merged (409)",
    empty_why: "`why` is empty (422)",
    bad_until: "`until` is given and is not `green` (422)",
    why_too_long: "`why` is longer than 200 characters (422)",
  },
};
