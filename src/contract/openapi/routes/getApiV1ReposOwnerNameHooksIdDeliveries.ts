import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/hooks/{id}/deliveries`,
  summary:
    "A webhook's last 20 deliveries, newest first (admin scope); answers { items: [{ id, state, attempts, lastStatus, lastError, kind }] }, never the secret, a payload or a signature",
  auth: true,
  role: "member",
};
