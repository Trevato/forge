import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/issues/{number}/dependencies/{blocker}/confirm`,
  summary:
    "Confirm that an issue may go ahead although its blocker closed as dropped or split (rw scope; a person who writes, never the crew); answers 204",
  auth: true,
  role: "member",
  status: 204,
  refusals: {
    not_found: "no such issue or blocker, or not yours to see (404)",
    unauthorized: "no account (401)",
    forbidden: "not a person who writes to the repository, or a crew member (403)",
  },
};
