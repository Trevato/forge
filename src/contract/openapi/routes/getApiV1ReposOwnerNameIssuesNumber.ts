import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/issues/{number}`, summary: "Read one issue with its comments; comments=N (0 to 200) answers only the newest N and commentCount, any other value is a 422 invalid_comments", auth: false, query: { comments: "integer" } };
