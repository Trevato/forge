import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/feed/interactions",
  summary:
    "Record the viewer's act on a feed item (item is a feed item id; kind is opened, dwelled, steered, told, swiped, shipped, shared, dismissed or muted; app is owner/name, read when item is not an event): answers 201 with { id }; an item or app the caller cannot read is a 404",
  auth: true,
  status: 201,
  body: { item: "string", kind: "string", app: "string" },
  refusals: {
    invalid_item: "422, item is not a feed item id",
    invalid_kind: "422, kind is not one the feed knows",
    not_found: "404, the event or app is not readable by the caller",
  },
};
