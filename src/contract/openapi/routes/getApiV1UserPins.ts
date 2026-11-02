import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/pins",
  summary: "List the repositories you pinned; answers { items: [{ repoId, owner, name, defaultBranch, cloneUrl, sshUrl, origin, pinnedAt }], next_cursor }; limit and cursor page it",
  auth: true,
  query: { limit: "integer", cursor: "string" },
};
