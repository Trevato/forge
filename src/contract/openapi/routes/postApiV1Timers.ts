import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/timers",
  summary: "An app arms a one-shot timer with its own token: the forge wakes the app and POSTs the path at that time, signed, with the key as its idempotency key; arming a key again replaces it; answers 201 with the timer",
  auth: true,
  role: "member",
  status: 201,
  body: { at: "an ISO date, or in: seconds or 10m, 2h, 3d (exactly one); within a year", in: "seconds, or a number with s, m, h or d", path: "the absolute path on the app to POST to", key: "optional: 1-100 letters, digits, . _ : -", body: "optional: JSON or text up to 64 KB, sent as the request body" },
  refusals: {
    invalid: "422: a field is wrong; the sentence names it",
    too_many: "429: the app holds as many pending timers as FORGE_TIMERS_PER_APP allows",
    unauthorized: "401: not an app's own token",
  },
};
