import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/issues/{number}/comments`,
  summary: "Comment on an issue or pull",
  auth: true,
  role: "member",
  body: { body: "string" },
};
