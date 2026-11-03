import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/builds`,
  summary: "Pin a commit as a build (rw scope, a writer's) at refs/builds/<label>; answers 201 with the pin",
  auth: true,
  body: { label: "string", sha: "string", note: "string", parent: "string", source: "string" },
  status: 201,
  refusals: { exists: "409: a pin with that label already exists" },
};
