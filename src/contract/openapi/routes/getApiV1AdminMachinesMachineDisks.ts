import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/machines/{machine}/disks",
  summary:
    "Read a machine's disk readings (a person admin's token, any scope): per device the latest reading, bytesWrittenInWindow over spanDays (the oldest reading within 30 days of the latest to the latest, so ≤ 30 days, not always 30), ratedReachedAt and the assessment",
  auth: true,
  refusals: { not_found: "the token is not a person who administers the forge, or the machine has no readings" },
};
