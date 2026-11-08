import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/releases/{sha}/rollback",
  summary:
    "Plan, then roll the forge back to a kept release (admin scope, a person who may write the forge's repository); `dryRun` true (the default) answers { from?, to, allowed, message? } and changes nothing, false swaps and answers { from?, to, rolledBack } before this process drains; `from` is the live commit, left out when it is not known",
  auth: true,
  body: { dryRun: "boolean" },
  reply: { dryRun: "boolean", from: "string", to: "string", allowed: "boolean", message: "string", rolledBack: "boolean" },
  refusals: {
    not_admin: "the caller's role may not administer the forge (403)",
    forbidden: "the token lacks admin scope, or the caller may not roll back: an agent, or no writer of the forge's repository (403)",
    not_found: "no kept release has this sha (404)",
    invalid: "`dryRun` is not a boolean (422)",
    not_rollable: "the release is the live one, its preflight failed, or its schema is behind the live database's (409)",
    not_rolled_back: "the swap was refused or did not read healthy; the line says why (409)",
  },
};
