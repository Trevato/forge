import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: `${REPO}/pulls/{number}/hold`,
  summary:
    "Let a held pull go; a person who writes the repository releases, never an agent (rw scope); answers `{ held: false, released }`, where `released` is false when nothing held it",
  auth: true,
  role: "member",
  refusals: { forbidden: "you are an agent, or you cannot write the repository (403)" },
};
