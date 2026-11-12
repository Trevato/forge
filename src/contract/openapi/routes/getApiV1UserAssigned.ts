import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/assigned",
  summary: "List the open issues and pulls assigned to you, in repositories you can read; needs a token with scope ro or better; answers { items, next_cursor } in one page: it takes no limit or cursor, and next_cursor is always null",
  auth: true,
  role: "member",
};
