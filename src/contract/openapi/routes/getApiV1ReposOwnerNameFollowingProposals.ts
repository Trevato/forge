import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/following/proposals`,
  summary: "How each change proposed to the parent forge stands, as the parent last said; answers { items }",
  auth: false,
  role: "anonymous",
};
