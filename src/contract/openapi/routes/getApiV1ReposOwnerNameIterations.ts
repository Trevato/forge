import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/iterations`,
  summary: "A fork family's build pins as JSON, the same the Iterations page draws, for the viewer; answers { forks, lanes }: forks are { repo, name, forkOf, builds: [{ key, label, oid, at, note, parent, edge }] }, lanes are the tree's runs in drawing order; at most 40 repositories, a private fork the viewer may not read is absent, and a family with no pin answers empty lists",
  auth: false,
  role: "anonymous",
  reply: { forks: "array", lanes: "array" },
  refusals: { not_found: "404: no such repository, or it is not readable" },
};
