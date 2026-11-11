import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/milestones/{number}/watch`,
  summary: "Watch a milestone: the caller's own watch, so a write token and nothing more (a person's; an agent is refused); answers { watching }",
  auth: true,
  role: "member",
  refusals: {
    unauthorized: "401: no signed-in account",
    forbidden: "403: only a person watches a milestone",
    not_found: "404: no such repository, or it is not readable, or the number is no milestone",
  },
};
