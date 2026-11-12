import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/contents`,
  summary:
    "Commit files to a branch without git (rw scope): files is [{ path, content }]; answers 201 with the commit",
  auth: true,
  role: "member",
  status: 201,
  body: { branch: "string", base: "string", message: "string", files: "array" },
  refusals: {
    invalid_branch: "branch or base is not a safe ref name",
    invalid_path: "a file path is not a safe relative path",
    path_conflict: "a path is a directory in the tree, or an ancestor of it is a file",
    no_files: "files holds nothing to write",
    protected_branch: "the default branch is protected and the caller is not a repo admin",
    file_too_large: "a file is over the per-file limit",
    commit_too_large: "the files together are over the per-commit limit",
    branch_moved: "the branch moved while committing (409)",
    land_refused: "the commit could not be landed on the branch",
    git: "git failed while committing",
  },
};
