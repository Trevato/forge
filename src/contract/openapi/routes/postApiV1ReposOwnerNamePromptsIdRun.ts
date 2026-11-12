import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/prompts/{id}/run`,
  summary: "Look at a prompt source now, whatever the hour (admin scope); answers the source as the run left it",
  auth: true,
  role: "member",
  refusals: {
    no_such_source: "the repository has no such prompt source (422)",
    not_running: "the prompt routine is not running on this forge (422)",
  },
};
