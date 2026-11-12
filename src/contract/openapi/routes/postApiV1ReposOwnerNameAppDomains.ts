import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/app/domains`,
  summary: "Add a domain of your own to the app (admin scope); answers 201 with the domain",
  auth: true,
  role: "member",
  body: { host: "string" },
  status: 201,
};
