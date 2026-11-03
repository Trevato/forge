import { REPO, type Route, limitTo } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/issues/{number}/comments`, summary: "Page through an issue's or pull's comments, oldest first: {comments, next}; limit 1 to 100 (default 50), after a comment id; cursor (an issue's commentsNext) answers the page of older comments before it, next being the cursor for older still", auth: false, query: { after: "string", cursor: "string", limit: limitTo(100) } };
