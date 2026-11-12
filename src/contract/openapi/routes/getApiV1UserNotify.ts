import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/notify",
  summary: "Read whether your phone notify URL is set; answers { set, host } with the host only, never the full URL; a person's, an agent gets 403",
  auth: true,
  role: "member",
  refusals: { unauthorized: "401: no valid credentials were sent", forbidden: "403: the caller is an agent" },
};
