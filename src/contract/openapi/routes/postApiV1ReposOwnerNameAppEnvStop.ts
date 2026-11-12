import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "post", path: `${REPO}/app/{env}/stop`, summary: "Stop an environment (rw scope); answers {}", auth: true, role: "member" };
