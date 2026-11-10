import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/boards/{slug}",
  summary: "Write a board, making it or replacing it; answers the board as saved. Every panel's query is run first",
  auth: true,
  role: "admin",
  body: { title: "string", range: "string", refresh: "string", panels: "array" },
  refusals: {
    bad_json: "the body is not JSON (400)",
    refused: "the board or a panel's query is refused, with the reason (422)",
    invalid: "the board is malformed (422)",
    too_many: "the owner is at the board limit (422)",
    exists: "the board already exists (409)",
    branch_moved: "the boards changed while writing (409)",
    too_large: "the body is too large (413)",
  },
};
