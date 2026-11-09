import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/hooks/{id}/pause`,
  summary:
    "Pause this webhook: no new event is queued for it, and what is queued waits (admin scope); answers { id, active: false }, 404 unless you administer the repository and the hook is its own",
  auth: true,
};
