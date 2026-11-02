import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/issues/{number}`, summary: "Read one issue with its newest 50 comments, oldest first, commentsTotal and commentsNext (a cursor for …/comments?cursor=, null when no older comment is left to fetch, and with comments=0, which shows none: read …/comments); comments=N (0 to 200) asks for another count, adds commentCount, any other value is a 422 invalid_comments", auth: false, query: { comments: "integer" } };
