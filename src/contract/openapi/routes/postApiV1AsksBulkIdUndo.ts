import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/asks/bulk/{id}/undo",
  summary: "Undo a bulk action on asks by its operation id (rw scope); answers 201 with the undoing operation",
  auth: true,
  status: 201,
  refusals: {
    not_found: "no such asks operation here",
    already_undone: "the operation was undone already (409)",
    expired: "too long has passed to undo it (409)",
  },
};
