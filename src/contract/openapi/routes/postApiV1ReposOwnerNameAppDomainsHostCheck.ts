import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "post", path: `${REPO}/app/domains/{host}/check`, summary: "Check that a domain points at the forge (admin scope); answers the domain", auth: true, role: "member" };
