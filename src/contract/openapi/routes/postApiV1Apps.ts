import type { Route } from "../shared.ts";

/** What `POST /api/v1/apps` reads from its body, and the refusals it answers. */
const APP_BODY = { name: "string", owner: "string", description: "string", sentence: "string", visibility: "string", agent: "string", pick: "boolean" };
const APP_REFUSALS = {
  unverified: "the account has not verified its email",
  no_name: "no `name`, and the `sentence` leaves nothing to make one from",
  app_limit: "the owner is at the app limit",
  no_such_agent: "`agent` names no one on the crew",
  slug_taken: "another app already has this name's slug",
  name_taken: "the owner already has a repository of this name",
};

export const route: Route = {
  method: "post",
  path: "/api/v1/apps",
  summary: "Make an app (named by `name`, or derived from `sentence` alone; `name` wins when both are given): a repository, its app and a first issue; answers 201 with { repo, app, issue }",
  auth: true,
  status: 201,
  body: APP_BODY,
  refusals: APP_REFUSALS,
};
