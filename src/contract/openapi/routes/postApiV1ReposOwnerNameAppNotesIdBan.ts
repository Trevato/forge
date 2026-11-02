import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/app/notes/{id}/ban`,
  summary: "Hide a note and ban its sender from this app (rw scope; admin of the repository); answers the note",
  auth: true,
  refusals: {
    not_found: "no such repository, app or note",
    forbidden: "not an admin of the repository, or a read-only token",
  },
};
