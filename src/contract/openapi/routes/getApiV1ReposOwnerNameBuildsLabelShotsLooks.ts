import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/builds/{label}/shots/looks`,
  summary: "List the pictures the forge took when a deploy of the pin's commit came up, the ones the caller may see; answers { items, next_cursor }, each item { id, page, kind, theme, env, url }",
  auth: false,
};
