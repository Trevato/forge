import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/conversation/messages",
  summary: "Say something to the forge's own agent, as the signed-in person: it answers through the forge's MCP with that person's permissions, resuming their conversation; a message sent while it answers is steered into the turn; answers 202 at once, read the answer from the turns; at most 12 a minute per person",
  auth: true,
  status: 202,
  body: { text: "string" },
  reply: { how: "string" },
  refusals: {
    invalid_text: "text is not a string of 1 to 20000 characters",
    too_large: "the body is over 128000 bytes (413)",
    no_account: "no Claude account is granted to the person (403)",
    resting: "the account that serves the person is resting or out of budget (429)",
    rate_limited: "more than 12 messages in a minute (429)",
    off: "the forge's agent is not running here (503)",
    forbidden: "the request is cross-origin",
  },
};
