import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "delete", path: `${REPO}/hooks/{id}`, summary: "Remove a webhook (admin scope); answers {}, 404 when it is not there", auth: true, role: "member" };
