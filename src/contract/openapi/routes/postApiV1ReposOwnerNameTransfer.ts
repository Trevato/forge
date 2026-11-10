import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/transfer`,
  summary: "Move a repository to another owner, an account or an organisation the caller may create repositories under (rw scope, a repository admin's); its old web and API paths answer 308 to the new ones; answers the repository",
  auth: true,
  role: "member",
  body: { newOwner: "string" },
  refusals: {
    not_found: "404: no such repository, or the caller is not its admin",
    bad_new_owner: "422: newOwner is not a name",
    unknown_owner: "422: no account or organisation has that name",
    forbidden_owner: "403: the caller cannot create repositories under that owner",
    name_taken: "409: the new owner already has a repository by that name",
    same_owner: "409: the repository already belongs to that owner",
    move_failed: "500: the repository could not be moved; nothing changed",
  },
};
