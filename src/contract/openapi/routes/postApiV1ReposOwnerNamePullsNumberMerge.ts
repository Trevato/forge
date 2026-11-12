import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "post", path: `${REPO}/pulls/{number}/merge`, summary: "Merge a pull (a person's)", auth: true, role: "member" };
