import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/asks/decide/{id}/undo",
  summary: "Undo a decision by its id (rw scope); answers 201",
  auth: true,
  role: "member",
  status: 201,
  refusals: { not_found: "no such decision", expired: "a day has passed; it stays set aside (409)" },
};
