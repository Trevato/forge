import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/pulls/{number}/reviews`, summary: "List a pull's line-anchored review comments, each with its `anchor` and whether it is `outdated`", auth: false, role: "anonymous" };
