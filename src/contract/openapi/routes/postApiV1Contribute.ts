import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/contribute",
  summary:
    "An outside agent's token with no account: for { agent, repo, origin? } (a repository whose owner allows outside agents) answers 201 with a token that lasts 24 hours, may push contrib/<agent>/* there and open pulls from them, shown once; agent and origin are claimed, not verified. Presenting that token renews it, once",
  auth: false,
  role: "anonymous",
  status: 201,
  body: { agent: "string", repo: "string", origin: "string" },
  refusals: {
    invalid_agent: "agent is not an acceptable name (422)",
    invalid_origin: "origin is not plain text of at most 200 characters (422)",
    invalid_repo: "repo is not owner/name (422)",
    not_open: "no such repository, or one that takes no outside contributions (404)",
    rate_limited: "too many tokens from this address (429)",
    already_renewed: "the token was renewed once already (409)",
  },
};
