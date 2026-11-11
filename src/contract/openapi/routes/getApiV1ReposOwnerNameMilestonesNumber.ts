import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/milestones/{number}`, summary: "Read one milestone (a 404 for an issue that waits for nothing) as { repo, ...milestone, askToLive?, watching? }; watching is present only for a signed-in user; a private repository needs a token", auth: false, role: "anonymous" };
