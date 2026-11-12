import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/requests",
  summary: "The strangers waiting for an account, oldest first (a forge admin's, read scope; anyone else gets 404); answers { items: [{ username, note, source, state, askedAt, decidedAt }], next_cursor }",
  auth: true,
  role: "admin",
};
