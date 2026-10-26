import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/make-it-yours`,
  summary:
    "Take an app as your own: a fork with its app; a dry run (the default, ro scope) answers the plan, dryRun false (rw scope) answers 201 with the plan and `url`",
  auth: true,
  body: { dryRun: "boolean", name: "string", visibility: "string" },
  refusals: {
    invalid: "422: visibility is public or private",
    own: "409: this app is already yours",
    unverified: "403: prove your email first",
    limit: "429: at most so many copies a day; { resetsAt }",
    repository_limit: "403: at the repository limit",
    storage_limit: "403: at the storage limit",
    not_member: "403: not a member",
  },
};
