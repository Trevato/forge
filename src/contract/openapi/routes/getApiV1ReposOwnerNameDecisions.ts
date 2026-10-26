import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/decisions`,
  summary: "Read the decision ledger; `kind` is next, land, retry or guard; answers { decisions, week }",
  auth: false,
  query: { kind: "string" },
};
