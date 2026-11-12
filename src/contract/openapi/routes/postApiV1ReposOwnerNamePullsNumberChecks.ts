import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/pulls/{number}/checks`,
  summary: "Ask for a check again at the pull's head as it is now (rw scope, a writer's); answers 202 with { run }",
  auth: true,
  role: "member",
  status: 202,
  reply: { run: "object" },
  refusals: {
    forbidden: "only a writer can ask for a check (403)",
    not_open: "only an open pull is checked (409)",
    no_checks: "this forge runs no checks (409)",
    no_check_declared: "this head declares no check, or waits for a writer's approval (409)",
  },
};
