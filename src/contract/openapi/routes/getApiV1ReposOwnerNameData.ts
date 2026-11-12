import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/data`,
  summary:
    "The SQLite databases of the repository's app that you may read, as the MCP data tool with repo lists them: { items: [{ env, file, label }] }; only people who can write the repository (and admins) see them, anyone else a 404; needs a token",
  auth: true,
  role: "member",
};
