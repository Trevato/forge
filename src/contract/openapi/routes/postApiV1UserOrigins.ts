import type { Route } from "../shared.ts";

const U = "no valid credentials were sent";
const F = "the credential is not the account: a session from another origin, or a token without admin scope";

export const route: Route = {
  method: "post",
  path: "/api/v1/user/origins",
  summary: "Connect a forge with a personal access token; answers 201 with the origin and `reattached`, the frozen mirrors this brought back and the ones it could not, each with its reason; `host` is a name (github), a host or a URL and defaults to `kind`; the account only (session, password or admin-scope token); the token is stored sealed and never read back",
  auth: true,
  status: 201,
  body: { kind: "string", host: "string", token: "string" },
  refusals: {
    unauthorized: U,
    forbidden: F,
    unknown_host: "422, that does not look like a forge host",
    private_host: "422, that address is inside a network, not on the internet",
    unreachable: "422, that host could not be reached",
    bad_token: "422, the token is empty or the origin rejected it",
    already_connected: "422, that account is already connected here",
    rate_limited: "429, too many connect attempts; wait a minute",
  },
};
