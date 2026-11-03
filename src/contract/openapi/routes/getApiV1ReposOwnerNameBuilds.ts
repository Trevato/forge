import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/builds`,
  summary: "List a repository's build pins (refs/builds/<label>), newest first; each item is { label, oid, note, parent, source, pinnedBy, pinnedAt }; answers { items, next_cursor }",
  auth: false,
  reply: { items: "array", next_cursor: "null" },
  refusals: { not_found: "404: no such repository, or it is not readable" },
};
