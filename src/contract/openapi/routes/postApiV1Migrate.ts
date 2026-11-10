import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/migrate",
  summary:
    "Migrate a repository here: source is { url } (needs rw scope) or { originId, fullName } (needs admin scope); after is leave, archive or mirror; branch defaults to the one with the newest commits; crew is { agent, autonomous }; answers 202 with { repo, job }, the clone job watched at /api/v1/migrate/{job}",
  auth: true,
  role: "member",
  status: 202,
  body: { source: "object", owner: "string", name: "string", visibility: "string", branch: "string", after: "string", crew: "object" },
  refusals: {
    unauthorized: "401: no signed-in account",
    invalid_source: "422: source is neither { url } nor { originId, fullName }",
    invalid_after: "400: `after` is not leave, archive or mirror",
    unverified: "403: the account has not verified its email",
    repository_limit: "403: the owner is at the repository limit",
    storage_limit: "403: the owner is at the storage limit",
    invalid_url: "422: the URL is not one this forge will clone from",
    private_host: "422: the URL is inside the network",
    no_such_origin: "422: the origin is not the caller's, or has no such repository",
    unreachable: "422: the source could not be reached",
    invalid_branch: "422: the branch is not in the source",
    no_such_agent: "422: `crew.agent` names no one on the crew",
  },
};
