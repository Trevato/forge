import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: `${REPO}/pulls/{number}`,
  summary: "Edit a pull's title or body and open or close it (rw scope); answers the pull",
  auth: true,
  role: "member",
  body: { title: "string", body: "string", state: "string" },
  refusals: {
    invalid_text: "`title` or `body` is not a string (422)",
    invalid_state: "`state` is neither open nor closed (422)",
    invalid_reason: "`reason` or `into` is given; a pull has none (422)",
    nothing_to_change: "none of `title`, `body` and `state` is given (422)",
    taken_up: "someone who directs the crew has acted on the words, so an agent may not edit them (403)",
    forbidden: "you may not open or close this pull (403); a planner may close only an agent's pull whose issue is closed",
  },
};
