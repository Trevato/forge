import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/forks`, summary: "List the forks of a repository you can read", auth: false };
