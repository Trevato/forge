import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/pulls/{number}/threads/{anchor}/resolve`,
  summary: "Mark a review thread resolved (rw scope; the thread's author or a writer); answers the thread",
  auth: true,
  role: "member",
  refusals: {
    not_found: "the pull has no thread at `anchor` (404)",
    forbidden: "you neither wrote the thread's comments nor can write to the repository (403)",
  },
};
