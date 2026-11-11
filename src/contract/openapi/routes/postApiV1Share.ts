import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/share",
  summary:
    "Send a feed item to up to 10 people: `to` is one username or a list of them, each with or without a leading @; left out, the item goes to the app's crew and owners (or its followers). Answers 201 with { sent: [{ to, outcome }] }, one entry per recipient, outcome being delivered, queued, steered, told, duplicate, skipped or unreachable (no such person, or not one who can see the item); an item the caller cannot read is a 404",
  auth: true,
  role: "member",
  status: 201,
  body: { item: "string", to: "array" },
  refusals: {
    invalid_item: "422, item is not a feed item id",
    invalid_target: "422, to is more than 10 usernames or not usernames",
    not_found: "404, the item is not readable by the caller",
  },
};
