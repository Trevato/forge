import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/issues`,
  summary: "Open an issue",
  auth: true,
  role: "member",
  body: { title: "string", body: "string" },
};
