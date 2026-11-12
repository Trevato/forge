import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/app/notes`,
  summary: "List the notes sent from the app's forge button (rw scope; admin of the repository); answers { notes, banned }",
  auth: true,
  role: "member",
  refusals: {
    not_found: "no such repository, or it is not an app",
    forbidden: "not an admin of the repository, or a read-only token",
  },
};
