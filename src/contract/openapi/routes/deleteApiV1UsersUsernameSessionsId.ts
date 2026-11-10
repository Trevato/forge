import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/users/{username}/sessions/{id}",
  summary: "End one browser session of a person, as when a device is lost; the person themself or the forge's owner, with a browser session, a password or an admin-scope token; answers 204 and never a session secret",
  auth: true,
  role: "member",
  status: 204,
  refusals: {
    unauthorized: "no credentials were sent",
    forbidden: "the caller holds a token below admin scope",
    not_found: "no such account or session, or it is not one the caller may end",
  },
};
