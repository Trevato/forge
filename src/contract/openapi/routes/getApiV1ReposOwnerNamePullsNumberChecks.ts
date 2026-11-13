import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/pulls/{number}/checks`,
  summary: "A pull's checks at its current head; answers { head, state, required, run, runs } with state `none` when no run exists; `?format=text` answers three plain-text lines (`state:`, `head:`, `required:`) instead",
  auth: false,
  role: "anonymous",
  query: { format: "string" },
  reply: { head: "string", state: "string", required: "boolean", run: "object", runs: "array" },
};
