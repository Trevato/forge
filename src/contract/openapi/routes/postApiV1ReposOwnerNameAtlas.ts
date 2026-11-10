import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/atlas`,
  summary: "Check a business plan of apps, adapters and edges; with confirm, open its issues once",
  auth: true,
  role: "member",
  body: { plan: "object" },
};
