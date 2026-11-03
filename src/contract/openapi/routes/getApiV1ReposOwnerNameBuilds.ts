import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/builds`, summary: "List a repository's build pins (refs/builds/<label>), newest first; answers { items, next_cursor }", auth: false };
