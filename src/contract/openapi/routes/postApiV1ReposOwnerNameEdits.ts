import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/edits`,
  summary:
    "Commit files without git (rw scope): files is [{ path, content }], content null deletes; answers 201 with { commit, branch, pull }",
  auth: true,
  role: "member",
  status: 201,
  body: { branch: "string", base: "string", message: "string", newBranch: "string", files: "array", openPull: "object" },
  refusals: { no_files: "files holds nothing to write" },
};
