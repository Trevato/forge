import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/hooks/{id}/resume`,
  summary:
    "Resume a paused webhook: new events are queued for it again and what waited goes out (admin scope); answers { id, active: true }, 404 unless you administer the repository and the hook is its own",
  auth: true,
  role: "member",
};
