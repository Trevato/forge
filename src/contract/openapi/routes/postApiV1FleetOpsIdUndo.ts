import type { Route } from "../shared.ts";

export const route: Route = { method: "post", path: "/api/v1/fleet/ops/{id}/undo", summary: "Undo a fleet operation (admin scope); answers 201 with the undoing operation", auth: true, role: "member", status: 201 };
