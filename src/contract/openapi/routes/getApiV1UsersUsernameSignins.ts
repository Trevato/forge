import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/users/{username}/signins",
  summary: "List where a person is signed in: answers { tokens, sessions }, each token { id, name, scope, createdAt, lastUsedAt, expiresAt } and each live browser session { id, createdAt, lastSeenAt, expiresAt, current }; a session's secret and a token's value are never answered; the person themself or the forge's owner, with a browser session, a password or an admin-scope token",
  auth: true,
  role: "member",
  refusals: {
    unauthorized: "no credentials were sent",
    forbidden: "the caller holds a token below admin scope",
    not_found: "no such account, or it is not one the caller may see",
  },
};
