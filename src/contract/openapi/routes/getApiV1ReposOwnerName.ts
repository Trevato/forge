import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: REPO,
  summary:
    "Read one repository; `provenance` is where a migrated one came from ({ source, sourceUrl, parents: [{ fullName, url }], migratedAt }), null when it was not migrated or its owner hid it; `upstream` is the stored follow check ({ repo, behind, checkedAt, conflict }), shown to an admin of the repository, null when it follows nothing or to anyone else; `credit` is a mirror's { upstream: { fullName, htmlUrl, viaFork }, licence, authors }, null for a repository that is not a mirror",
  auth: false,
  role: "anonymous",
  refusals: { not_found: "404: no such repository, or it is not readable by the caller" },
};
