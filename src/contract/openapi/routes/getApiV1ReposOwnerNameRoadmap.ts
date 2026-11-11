import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/roadmap`, summary: "Read the roadmap: the repository's pillars in order, what is building, what landed, what is next and when each finishes; 404 where the repository names no pillars", auth: false, role: "anonymous" };
