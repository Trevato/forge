import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/pulls/{number}/looks`,
  summary: "List a pull's looks, newest first, as { items: [{ id, width, says, by, commit, url, at }] }; empty when the pull has no app or no looks",
  auth: false,
  role: "anonymous",
};
