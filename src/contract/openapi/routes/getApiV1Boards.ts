import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/boards",
  summary: "List the owner's boards; answers { boards: [{ slug, title, range, refresh, panels }] }. Site admin people only",
  auth: true,
  role: "admin",
};
