import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: `${REPO}/pulls/{number}/threads/{anchor}/resolve`,
  summary: "Reopen a resolved review thread (rw scope; the thread's author or a writer); answers the thread",
  auth: true,
  role: "member",
  refusals: {
    not_found: "the pull has no thread at `anchor` (404)",
    forbidden: "you neither wrote the thread's comments nor can write to the repository (403)",
  },
};
