import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "post", path: `${REPO}/pulls/{number}/slices`, summary: "Land a pull's commits up to one as their own merge (a person's)", auth: true, role: "member" };
