import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/traffic/visitors",
  summary:
    "Read who comes back (a person admin's token, any scope); query: days (1-90, default 30); answers { as_of, enabled, days, per_day: [{ day, new_cookie, returning_cookie, new_probable, returning_probable }], new_visitors, returning_visitors, returning: [{ id (shortened), probable, visits, days_seen, first_seen, last_seen, first_ref, last_ref, step, forge }], led: [{ forge, id, probable, step, first_ref, visits: [{ day, ref, pages }] }], probe: { new, returning, agrees } } where probe counts the stored visitor rows again; a probable id is a salted hash of coarse request facts, never merged with a cookie id",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge" },
};
