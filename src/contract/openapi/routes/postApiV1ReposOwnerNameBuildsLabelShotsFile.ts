import { REPO, SHOT_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/builds/{label}/shots/{file}`,
  summary: "Edit one screenshot (rw scope, a person who writes): a new `caption`, and/or `move` up or down one place; `at` is the `tree` it was read from; answers the list",
  auth: true,
  role: "member",
  body: { caption: "string", move: "string", at: "string" },
  refusals: { ...SHOT_REFUSALS, no_such_shot: "404: the pin has no screenshot by that name", invalid_caption: "422: more than one line or 140 characters", invalid_move: "422: move is up or down" },
};
