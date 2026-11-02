import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: `${REPO}/issues/{number}`,
  summary: "Close or reopen an issue (state, with a reason and the issue it went into)",
  auth: true,
  body: { state: "string", reason: "string", into: "integer" },
};
