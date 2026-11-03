import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: `${REPO}/builds/{label}`,
  summary: "Edit a build's notes: `notes` is the whole text (markdown, at most 10 KB; its first line is the summary), written as `<label>.md` in one commit on `refs/forge/notes` by the editor; the tag is not rewritten. `note` (the first line) and `body` (the rest) are still taken for one release and joined into the file, a field left out staying (rw scope, a person who writes); answers the pin",
  auth: true,
  body: { notes: "string", note: "string", body: "string" },
  refusals: {
    forbidden: "403: not a person who writes the repository (an agent is refused)",
    not_found: "404: no such repository or pin, or the caller cannot read it",
    invalid_note: "422: the notes pass 10 KB, or `note` is not one line of at most 200 characters",
    mirrored: "409: the repository mirrors an origin",
    moved: "409: the pin changed while it was being edited",
    git_failed: "422: git refused the change",
  },
};
