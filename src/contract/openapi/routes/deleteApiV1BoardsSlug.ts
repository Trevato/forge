import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/boards/{slug}",
  summary: "Delete a board; answers { deleted: true }",
  auth: true,
  role: "admin",
};
