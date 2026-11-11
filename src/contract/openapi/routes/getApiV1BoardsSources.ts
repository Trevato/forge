import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/boards/sources",
  summary: "List the sources a board query reads; answers { sources: [{ name, time, columns, docs? }] }",
  auth: true,
  role: "admin",
};
