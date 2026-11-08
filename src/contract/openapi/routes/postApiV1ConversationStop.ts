import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/conversation/stop",
  summary: "Stop the forge's agent mid-answer, as the signed-in person: its run and every process it started end, what it said so far stays and is marked stopped, and a write waiting for a Confirm is cancelled, never applied; answers 202",
  auth: true,
  status: 202,
  reply: { stopped: "boolean" },
  refusals: {
    idle: "no answer is running (409)",
    off: "the forge's agent is not running here (503)",
    forbidden: "the request is cross-origin, or the token may only read",
  },
};
