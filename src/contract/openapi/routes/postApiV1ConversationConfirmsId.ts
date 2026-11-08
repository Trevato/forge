import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/conversation-confirms/{id}",
  summary: "The person's yes to a confirm the forge's agent asked in their conversation: does the stored call, with its stored arguments, exactly once, as the person by way of the agent; only the person's own browser session on the same origin says yes (a bearer token or password is 401); answers the result, the `tool` turn it wrote, with `undo` when the action has one",
  auth: false,
  refusals: {
    not_found: "no such confirm of the person's",
    answered: "the confirm was already answered (409)",
    expired: "the confirm is 10 minutes old or more (410)",
    forbidden: "the request is cross-origin, or the action is no longer the person's to take",
  },
};
