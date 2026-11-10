import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/builds/preview`,
  summary: "Serve one commit `{ sha }` at its own short-lived environment (rw scope, a writer's); nothing is stored; answers 201 with { env, url }",
  auth: true,
  role: "member",
  body: { sha: "string" },
  status: 201,
  reply: { env: "string", url: "string" },
};
