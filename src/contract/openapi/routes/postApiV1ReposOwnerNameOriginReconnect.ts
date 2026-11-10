import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/origin/reconnect`,
  summary: "Reconnect a frozen mirror through one of your origins (admin scope, repository admin); answers the repository",
  auth: true,
  role: "member",
  body: { originId: "string" },
};
