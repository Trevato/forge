import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "delete", path: `${REPO}/prompts/{id}`, summary: "Remove a prompt source (admin scope); answers {}", auth: true, role: "member" };
