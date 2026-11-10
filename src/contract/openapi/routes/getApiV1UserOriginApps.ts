import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/origin-apps",
  summary: "List your registered OAuth applications, one per origin host, as a bare array [{ id, userId, kind, apiUrl, webUrl, clientId, hasSecret, createdAt }]; the client secret is never read back, only hasSecret says one is held",
  auth: true,
  role: "member",
  refusals: {
    unauthorized: "401: no signed-in account",
    forbidden: "403: a cross-origin browser request, or a token without admin scope",
  },
};
