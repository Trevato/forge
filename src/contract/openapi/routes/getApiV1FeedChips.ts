import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/feed/chips",
  summary: "The chips the caller switched off, kinds of post and people (ro scope; never cached); answers { kinds, people }",
  auth: true,
  role: "member",
};
