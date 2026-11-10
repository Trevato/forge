import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/asks/proposal/{id}/{verb}",
  summary: "Act on a wave proposal (rw scope); `verb` is approve, redirect (with `words` to say what to do instead), later or again; answers 201",
  auth: true,
  role: "member",
  status: 201,
  body: { words: "string" },
  refusals: {
    forbidden: "a proposal is the owner's to decide, or the caller is not on the crew (403)",
    conflict: "it was already decided (409)",
    invalid: "no words for redirect, too long, no planner or direction issue, or the app is archived (422)",
    not_found: "no such proposal, or no such verb",
  },
};
