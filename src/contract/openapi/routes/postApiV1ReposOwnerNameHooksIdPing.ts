import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/hooks/{id}/ping`,
  summary:
    "Queue one signed `ping` delivery { kind, repo, hook, at } to this webhook only (admin scope); answers 202 { id } of the delivery, 429 past 3 a minute per hook",
  auth: true,
};
