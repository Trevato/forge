import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/conversation-tokens",
  summary: "Mint the token the forge's agent acts with in one conversation, as the signed-in person: rw, reaching the forge only through /mcp, fenced, expiring within the hour; `words` are what the person said to start the turn; without `conversation` a fresh one starts, with it only one of the person's own goes on; only the person's own browser session on the same origin mints it (a bearer token or password is 401); every event written with it names the person via the forge's agent; answers 201 with the token once",
  auth: false,
  role: "member",
  status: 201,
  body: { conversation: "string", words: "string" },
  refusals: {
    invalid_conversation: "conversation is not 1 to 40 lowercase letters or digits, or not one of the person's own",
    invalid_words: "words is not a string of at most 20000 characters",
    forbidden: "the request is cross-origin",
  },
};
