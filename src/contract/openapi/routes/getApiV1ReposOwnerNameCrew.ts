import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/crew`, summary: "List the repository's crew; answers { items, next_cursor } (names and roles for every reader, brief, model and budget for writers)", auth: false, role: "anonymous" };
