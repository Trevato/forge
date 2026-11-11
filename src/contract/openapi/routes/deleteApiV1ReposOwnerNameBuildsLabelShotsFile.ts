import { REPO, SHOT_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: `${REPO}/builds/{label}/shots/{file}`,
  summary: "Remove one screenshot from a pin (rw scope, a person who writes); `?at=` is the `tree` it was read from; answers 204",
  auth: true,
  role: "member",
  query: { at: "string" },
  status: 204,
  refusals: { ...SHOT_REFUSALS, no_such_shot: "404: the pin has no screenshot by that name" },
};
