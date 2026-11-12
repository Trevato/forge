import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/contribute`,
  summary:
    "Send files to a mirror's upstream as a branch, and optionally a pull (rw scope); answers 201 with the contribution; a repository that is not a mirror answers not_found",
  auth: true,
  role: "member",
  status: 201,
  body: { branch: "string", base: "string", message: "string", files: "array", openPull: "object" },
};
