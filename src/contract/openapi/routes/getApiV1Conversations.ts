import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/conversations",
  summary: "The signed-in person's conversations with the forge's agent, newest activity first; archived: 1 lists the put-away ones",
  auth: true,
  query: { archived: "string" },
  reply: { conversations: "array" },
};
