import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/crew/now",
  summary: "What the crew is doing right now, as MCP `now` answers it: { items: [{ run, app, who, on, why, state, since, costUsd, ran? }], next_cursor: null } for the apps the caller may read; a planner that declined the direction and waits for the caller comes first (`run: null`, its words in `says`), then pulls waiting for their review",
  auth: true,
  role: "member",
  refusals: { unauthorized: "no valid credentials were sent" },
};
