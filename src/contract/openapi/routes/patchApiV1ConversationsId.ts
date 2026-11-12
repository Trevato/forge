import type { Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: "/api/v1/conversations/{id}",
  summary: "Rename a conversation (title) or put it away and bring it back (archived: true or false); another person's id is 404",
  auth: true,
  role: "member",
  body: { title: "string", archived: "boolean" },
  reply: { conversation: "object" },
  refusals: { invalid_title: "title is over 80 characters or has a line break (422)", not_found: "no such conversation of yours (404)", forbidden: "the request is cross-origin, or the token is read-only" },
};
