import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/usage",
  summary: "What the forge spent across the apps the caller writes: today and last24h named apart, totals from every row, a removed subscription its own row, headroom per subscription window, percent in standing; 401 without a session",
  auth: true,
};
