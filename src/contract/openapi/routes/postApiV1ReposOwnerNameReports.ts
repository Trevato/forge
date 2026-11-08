import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/reports`,
  summary:
    "Report a problem in a public repository, without an account; answers 202 { id, state, filedBy, message }. With a token the report carries that account (filedBy { how: \"signed\", name }); without one, agent is kept as a claim (how \"claimed\"); with neither, how is \"anonymous\" and name null",
  auth: false,
  body: { title: "string", body: "string", page: "string", agent: "string" },
  status: 202,
};
