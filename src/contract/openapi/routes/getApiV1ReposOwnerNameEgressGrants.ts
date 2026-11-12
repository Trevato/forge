import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/egress-grants`, summary: "List the destinations the app may reach (admin scope); answers { items, changes, next_cursor }", auth: true, role: "member" };
