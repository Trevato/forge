import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/app/members`, summary: "Read the people a private app names; answers the members", auth: true, role: "member" };
