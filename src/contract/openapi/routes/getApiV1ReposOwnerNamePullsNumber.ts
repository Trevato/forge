import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/pulls/{number}`, summary: "Read one pull with its diff and review gate (diff=0 leaves the diff out); `check` is the word for the head's check: green, red, running or none", auth: false, query: { diff: "string" }, reply: { check: "string" } };
