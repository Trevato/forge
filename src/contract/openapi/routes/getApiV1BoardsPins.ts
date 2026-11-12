import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/boards/pins",
  summary: "List the owner's pinned panels in order; answers { pins: [{ slug, title, panel }] }",
  auth: true,
  role: "admin",
};
