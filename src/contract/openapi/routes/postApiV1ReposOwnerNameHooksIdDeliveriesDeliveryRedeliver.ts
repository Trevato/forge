import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/hooks/{id}/deliveries/{delivery}/redeliver`,
  summary:
    "Send a `failed` delivery again (admin scope, a repository you administer): the same row goes back to `pending` with attempts reset; answers { id, state }, 409 if the row is not failed or belongs to a sealed report, 404 otherwise",
  auth: true,
};
