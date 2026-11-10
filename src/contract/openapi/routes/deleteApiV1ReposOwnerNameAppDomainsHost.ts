import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "delete", path: `${REPO}/app/domains/{host}`, summary: "Remove a domain from the app (admin scope); answers {}", auth: true, role: "member" };
