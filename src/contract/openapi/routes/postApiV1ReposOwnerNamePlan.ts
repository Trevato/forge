import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/plan`,
  summary: "Open a plan of issues and their dependencies, all or nothing",
  auth: true,
  role: "member",
  body: { issues: "array" },
};
