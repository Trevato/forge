import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/feed/interactions",
  summary: "Record an act on a feed item, so the feed learns what the caller wants more or less of (rw scope); `item` is a feed item id, `kind` one the feed knows, `app` is owner/name and names the repository when the item is not an event; `liked` is a toggle, a second like takes it back, and answers 201 with { likes, liked }; any other answers 201 with { id }",
  auth: true,
  status: 201,
  body: { item: "string", kind: "string", app: "string" },
  refusals: {
    invalid_item: "`item` is not a feed item id (422)",
    invalid_kind: "`kind` is not one the feed knows (422)",
    not_found: "the item or repository is not one the caller can read",
  },
};
