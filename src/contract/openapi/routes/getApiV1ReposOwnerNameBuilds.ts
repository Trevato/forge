import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/builds`,
  summary: "List a repository's build pins (refs/builds/<label>), newest first; each item is { label, oid, note, parent, source, pinnedBy, pinnedAt }; answers { items, next_cursor }; the 200 carries a weak etag of the body and cache-control private, no-cache (it varies by reader), and a repeat sending If-None-Match gets 304 with no body until a pin is added, noted or deleted",
  alsoStatus: [304],
  auth: false,
  reply: { items: "array", next_cursor: "null" },
  refusals: { not_found: "404: no such repository, or it is not readable" },
};
