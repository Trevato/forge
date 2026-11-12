import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/prompts`, summary: "List the repository's prompt sources (admin scope); answers { items, next_cursor }, tokens never come back", auth: true, role: "member" };
