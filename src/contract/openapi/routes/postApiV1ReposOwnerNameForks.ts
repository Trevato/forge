import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "post", path: `${REPO}/forks`, summary: "Fork a repository", auth: true, role: "member" };
