import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/issues/{number}/plan`,
  summary: "Replace the issue's plan checklist whole (up to 12 items of { text, done? }, an empty list clears it); `ask` is what the run needs a person to answer and shows the run as needing input; answers { plan }",
  auth: true,
  role: "member",
  body: { items: "array", ask: "string" },
  refusals: {
    invalid: "items is not a list of up to 12 { text, done? }, or ask is not text",
    forbidden: "the caller is neither a writer nor on the repository's crew",
  },
};
