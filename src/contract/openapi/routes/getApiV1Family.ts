import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/family",
  summary: "The forge's family: { parent, here, children, more }; the parent for anyone, the children for a site admin",
  auth: false,
  role: "anonymous",
};
