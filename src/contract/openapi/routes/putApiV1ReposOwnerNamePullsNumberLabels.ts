import { LABEL_REFUSALS, REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/pulls/{number}/labels`,
  summary: "Replace the label set of a pull (names or ids; the set is all or nothing); answers the labels it now carries as a JSON array",
  auth: true,
  role: "member",
  body: { labels: "array" },
  refusals: LABEL_REFUSALS,
};
