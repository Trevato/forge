import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/pulls`,
  summary: "Offer a change as a pull",
  auth: true,
  role: "member",
  body: { title: "string", head: "string", headRepo: "string" },
};
