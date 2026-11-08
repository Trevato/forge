import { type Route, limitTo } from "../shared.ts";
import { MAX_PAGE } from "../../../core/conversations.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/conversation/turns",
  summary: "The signed-in person's conversation with the forge's agent: the latest turns, oldest first, and whether an answer is being written now",
  auth: true,
  query: { limit: limitTo(MAX_PAGE), before: "string", conversation: "string" },
  reply: { running: "boolean", turns: "array" },
};
