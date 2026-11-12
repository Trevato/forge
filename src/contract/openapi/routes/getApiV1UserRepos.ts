import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/repos",
  summary: "The caller's own repositories, private ones included, as a bare array in the Gitea shape (page, limit; Link rel=next): what a forge connecting to this one as an origin lists",
  auth: true,
  role: "member",
  refusals: { unauthorized: "no valid credentials were sent" },
};
