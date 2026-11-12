import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/spend`,
  summary: "Report what an outside session spent on this repository's work (needs rw scope; writers and the crew); answers 201 with the record",
  auth: true,
  role: "member",
  status: 201,
  body: { who: "string", tokensIn: "integer", tokensOut: "integer", usd: "number", model: "string", note: "string", issue: "integer" },
  refusals: { invalid: "who is 1 to 100 characters and some spend is given (tokensIn, tokensOut whole numbers; usd 0 to 10000); note is at most 500" },
};
