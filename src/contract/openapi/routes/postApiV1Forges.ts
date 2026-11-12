import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/forges",
  summary:
    "Make a forge, as a link: `dryRun` is true unless it is false and then answers 200 with { dryRun: true, plan, firstAdmin } and makes nothing; made, it answers 201 (200 when it already exists) with { dryRun: false, name, url, claimUrl, ... }. A signed-in caller needs rw scope; a stranger may call it, same-origin, rate-limited, with no crew, model key or `for`",
  auth: true,
  role: "member",
  status: 201,
  body: {
    name: "string",
    apps: "array",
    crew: "array",
    dryRun: "boolean",
    direction: "string",
    keepAccess: "boolean",
    size: "string",
    plan: "string (a key from GET /api/v1/plans; gives the size and a monthly crew credit; a paid plan is a forge admin's until payment exists)",
    for: "string",
    fresh: "boolean",
    followMode: "string",
    budgetUsd: "number",
    modelKey: "string",
    modelEndpoint: "string",
  },
  refusals: {
    invalid: "a field is missing or not valid",
    rate_limited: "a stranger has started enough forges today",
  },
};
