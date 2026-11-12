import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/builds",
  summary: "Build an app from one prompt (and optionally an offered template, owner/name): makes the repository, starts a conversation in it on its own branch and sends the prompt; the agent's turns that change code become versions v1, v2, …",
  auth: true,
  role: "member",
  status: 201,
  body: { prompt: "string", template: "string" },
  reply: { conversation: "string", repo: "string", branch: "string" },
  refusals: {
    invalid_template: "the template is not owner/name (422)",
    bad_template: "the template is not one on offer to you (422)",
    rate_limited: "at most 5 builds an hour (429)",
    too_many_builds: "you hold 10 builds that are not published (429)",
    unauthorized: "sign in (401)",
    forbidden: "the request is cross-origin, or the token may only read",
  },
};
