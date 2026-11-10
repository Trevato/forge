import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/app/domains`, summary: "List the app's own domains (admin scope); answers { items, next_cursor }", auth: true, role: "member" };
