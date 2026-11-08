import { REPO, SHOT_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/builds/{label}/shots/looks`,
  summary: "Copy deploy pictures into a pin's screenshots, in the order named (rw scope, a person who writes); answers 201 with the list",
  auth: true,
  body: { looks: "array" },
  status: 201,
  refusals: { ...SHOT_REFUSALS, nothing_picked: "422: no id names a picture of the pin's commit", too_many: "409: more than 12 screenshots", too_large: "413: a picture is over 2 MB" },
};
