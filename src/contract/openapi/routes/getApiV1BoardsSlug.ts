import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/boards/{slug}",
  summary: "Read one board: { slug, title, range, refresh, panels: [{ title, chart, query, w, h }] }",
  auth: true,
  role: "admin",
};
