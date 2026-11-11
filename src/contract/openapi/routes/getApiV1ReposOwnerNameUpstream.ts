import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/upstream`,
  summary: "The outside upstream this repository follows, for an admin: { following } (null when it follows none)",
  auth: true,
  role: "member",
};
