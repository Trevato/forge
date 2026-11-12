import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "post", path: `${REPO}/chapters`, summary: "Draft a chapter: `name` (the git tag it will carry, at most 40 characters) and `means`, one sentence of what done means. Only a person who administers the repository", auth: true, role: "member", body: { name: "string" } };
