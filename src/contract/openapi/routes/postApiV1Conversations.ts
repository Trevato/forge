import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/conversations",
  summary: "Start a new, empty conversation with the forge's agent; answers it, and it opens at /talk/<id>",
  auth: true,
  status: 201,
  body: { title: "string" },
  reply: { conversation: "object" },
  refusals: { invalid_title: "title is over 80 characters or has a line break (422)", forbidden: "the request is cross-origin, or the token is read-only" },
};
