import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/issues/{number}/comments`, summary: "Page through an issue's or pull's comments, oldest first: {comments, next}; limit 1 to 100 (default 50), after a comment id", auth: false, query: { after: "string", limit: "integer" } };
