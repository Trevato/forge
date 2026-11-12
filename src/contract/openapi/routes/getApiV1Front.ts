import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/front", summary: "The front page a stranger is shown: { featured, apps, total }, each entry { repo, description, url, state, picture, pinned, score, signals }; a site admin also gets `picks`", auth: false, role: "anonymous" };
