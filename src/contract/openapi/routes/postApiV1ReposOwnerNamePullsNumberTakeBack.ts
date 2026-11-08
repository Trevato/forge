import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "post", path: `${REPO}/pulls/{number}/take-back`, summary: "Open the pull that undoes a shipped one (a person's)", auth: true };
