import { LIST_QUERY, REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/issues`, summary: "List a repository's issues; fields=brief leaves out bodies and comments, any other fields value is a 422 invalid_fields", auth: false, query: { ...LIST_QUERY, fields: "string" } };
