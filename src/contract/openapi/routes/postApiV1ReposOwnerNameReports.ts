import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/reports`,
  summary: "Report a problem in a public repository, without an account",
  auth: false,
  body: { title: "string", body: "string", page: "string" },
};
