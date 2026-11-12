import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/codes",
  summary: "Make a gift code that gives a plan for free (a person admin's token, admin scope). dryRun is true unless false; the plain code and its /?code= link are in the answer that makes it, once",
  auth: true,
  role: "admin",
  body: { plan: "a paid plan key", uses: "how many times, default 1", note: "optional, up to 80 characters", expires: "optional date or time", dryRun: "true unless false" },
  refusals: { not_found: "the token is not a person who administers the forge (404)", bad_plan: "plan is not a paid plan (422)", bad_uses: "uses is not 1 to 1000 (422)", bad_note: "note is too long (422)", bad_expiry: "expires is not a future date (422)" },
};
