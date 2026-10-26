import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/tags`, summary: "List a repository's tags: [{ name, oid, commit }]", auth: false };
