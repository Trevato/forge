import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/crew/week",
  summary: "Read the crew's last 7 days (a forge admin's, any token scope): { days, members: [{ username, merged, returned, spentUsd, idle }] }, merged pulls, pulls returned by review and ledger spend per agent; idle is true when all three are nothing",
  auth: true,
  refusals: { unauthorized: "no valid credentials were sent", forbidden: "the caller is not a forge admin" },
};
