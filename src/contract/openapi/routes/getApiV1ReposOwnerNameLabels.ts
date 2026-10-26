import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/labels`, summary: "List a repository's labels by name as a bare array of { id, name, color }; a private repository needs a token", auth: false };
