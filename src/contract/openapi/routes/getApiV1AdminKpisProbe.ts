import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/kpis/probe",
  summary:
    "Read every home number against its source (a person admin's token, any scope); answers { as_of, tile_cache_seconds, numbers: [{ id, label, value, counts, inputs, recomputed, agrees }] }: value is what the tile shows, recomputed comes from the raw inputs read again past the home cache",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge" },
};
