import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "delete", path: `${REPO}/app`, summary: "Turn the app off (admin scope); answers {}", auth: true, role: "member" };
