import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/pulls/{number}/threads`, summary: "List a pull's review threads: every review comment sharing one anchor, and whether the conversation is resolved", auth: false, role: "anonymous" };
