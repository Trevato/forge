import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/builds`,
  summary: "Pin a commit as a build (rw scope, a person who writes) at refs/builds/<label>; answers 201 with the pin: { label, oid, note, parent, source, pinnedBy, pinnedAt }",
  auth: true,
  role: "member",
  body: { label: "string", sha: "string", note: "string", parent: "string", source: "string" },
  status: 201,
  reply: { label: "string", oid: "string", note: "string", parent: "string", source: "string", pinnedBy: "string", pinnedAt: "string" },
  refusals: {
    forbidden: "403: not a person who writes the repository (an agent is refused)",
    not_found: "404: no such repository, or the caller cannot read it",
    invalid_label: "422: the label is not a valid pin name",
    invalid_parent: "422: `parent` is neither a label nor `owner/name:label`",
    not_a_commit: "422: `sha` names no commit of the repository",
    exists: "409: a pin with that label already exists",
    mirrored: "409: the repository mirrors an origin",
    git_failed: "422: git refused the change",
  },
};
