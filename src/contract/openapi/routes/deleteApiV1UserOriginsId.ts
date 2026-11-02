import type { Route } from "../shared.ts";

const U = "no valid credentials were sent";
const F = "the credential is not the account: a session from another origin, or a token without admin scope";
const NF = "no such origin among the caller's";

export const route: Route = {
  method: "delete",
  path: "/api/v1/user/origins/{id}",
  summary: "Disconnect an origin: forget its credential, and revoke an OAuth grant upstream when there is one; answers { revokedUpstream }; repositories already migrated stay; the account only",
  auth: true,
  refusals: { unauthorized: U, forbidden: F, not_found: NF },
};
