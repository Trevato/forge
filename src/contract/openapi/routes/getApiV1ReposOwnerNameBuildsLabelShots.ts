import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/builds/{label}/shots`,
  summary: "List a pin's screenshots (a tree kept by refs/shots/<label>), in display order; answers { items, next_cursor, tree }, each item { file, caption, type, size, url }",
  auth: false,
  role: "anonymous",
};
