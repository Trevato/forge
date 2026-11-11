import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/issues/{number}/plan`,
  summary: "Read the plan checklist a crew run keeps on an issue; answers { plan }, null when there is none: { items: [{ text, done }], ask, runId, updatedAt }",
  auth: false,
  role: "anonymous",
};
