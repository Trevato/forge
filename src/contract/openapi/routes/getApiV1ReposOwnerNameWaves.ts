import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/waves`, summary: "Takes no query parameters (the list is not paged: next_cursor is always null). List what shipped, newest first, as { items: [{ version, date, headline }], next_cursor: null }; a file that is not a wave is left out; a private repository needs a token", auth: false, role: "anonymous", reply: { items: "array", next_cursor: "null" }, refusals: { not_found: "404: no such repository, or it is not readable" } };
