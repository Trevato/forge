import { type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/pins",
  summary: "List the repositories you pinned; answers { items: [{ repoId, owner, name, defaultBranch, cloneUrl, sshUrl, origin, pinnedAt }], next_cursor }; limit and cursor page it",
  auth: true,
  role: "member",
  query: { limit: limitTo(LIST_LIMIT_MAX), cursor: "string" },
};
