import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: `${REPO}/builds/{label}`,
  summary: "Delete a pin: refs/builds/{label} with its cover and screenshots; the commit stays (rw scope, a person who writes); answers 204",
  auth: true,
  status: 204,
  refusals: {
    forbidden: "403: not a person who writes the repository (an agent is refused)",
    not_found: "404: no such repository or pin, or the caller cannot read it",
    mirrored: "409: the repository mirrors an origin",
    moved: "409: the pin changed while it was being deleted",
    git_failed: "422: git refused the change",
  },
};
