import { LIST_QUERY, REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/pulls`, summary: "List a repository's pulls", auth: false, query: LIST_QUERY, refusals: { invalid_limit: "limit is not a whole number from 1 to 200 (422)" } };
