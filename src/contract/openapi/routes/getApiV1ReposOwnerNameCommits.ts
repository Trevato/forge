import { REPO, type Route, limitTo } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/commits`, summary: "List commits newest first from `ref` (default: the default branch) as a bare array of { oid, parents, author, email, date, subject, body }; limit 1 to 100 (default 30); an unsafe ref is a 422 bad_ref; a private repository needs a token", auth: false, query: { ref: "string", limit: limitTo(100) } };
