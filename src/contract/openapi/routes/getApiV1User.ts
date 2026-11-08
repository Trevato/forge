import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user",
  summary: "Read your own profile: the public fields plus emailVerified",
  auth: true,
};
