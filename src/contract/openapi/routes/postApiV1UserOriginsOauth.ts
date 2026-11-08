import type { Route } from "../shared.ts";

const U = "no valid credentials were sent";
const F = "the credential is not the account: a session from another origin, or a token without admin scope";

export const route: Route = {
  method: "post",
  path: "/api/v1/user/origins/oauth",
  summary: "Start connecting a forge by OAuth without handing over a token; answers 201 with { flowId, flow, userCode, url, shortCode, intervalSecs, expiresAt }: flow `device` (GitHub: a person enters `userCode` at `url`) or `code` (Forgejo, Gitea: a person opens `url`); then poll GET /api/v1/user/origins/oauth/{id} with the flowId; the account only",
  auth: true,
  status: 201,
  body: { kind: "string", host: "string" },
  refusals: {
    unauthorized: U,
    forbidden: F,
    unknown_host: "422, that does not look like a forge host",
    private_host: "422, that address is inside a network, not on the internet",
    unreachable: "422, that host could not be reached",
    no_app: "422, no OAuth application is registered for that host: register one at /api/v1/user/origin-apps, or connect with a token",
    provider_refused: "422, the forge refused to start the flow",
    rate_limited: "429, too many connect attempts; wait a minute",
  },
};
