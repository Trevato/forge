import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/queue`, summary: "Read the queue: every open issue in the order the dispatcher starts them; `queue` holds the rows and `notNow` counts those that cannot start yet", auth: false, role: "anonymous" };
