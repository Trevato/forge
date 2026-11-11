import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/app/env`, summary: "List the names of the app's environment variables (admin scope); a value is written and never read back; answers { items, next_cursor }", auth: true, role: "member" };
