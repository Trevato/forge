import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/openapi.json",
  summary: "The address an agent tries first: answers 308 to /contract/openapi.json, this document",
  auth: false,
  role: "anonymous",
  status: 308,
};
