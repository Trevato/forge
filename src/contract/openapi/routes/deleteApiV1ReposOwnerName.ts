import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: REPO,
  summary: "Delete a repository for good (admin scope, an admin's); answers {}",
  auth: true,
  role: "member",
  refusals: { not_found: "404: no such repository, or the caller is not its admin", delete_failed: "500: the repository could not be removed" },
};
