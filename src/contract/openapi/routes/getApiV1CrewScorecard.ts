import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/crew/scorecard",
  summary: "Read the crew's scorecard (a forge admin's, any token scope): { agents: [{ username, all, recent, splits }] }, where all and recent are { opened, landed, reviewRounds, redCheckRate, reverts, meanLandMs } or null, and each split adds model, prompt and its own recent; also modelDays (runs, landed and spend per model per day) and wastedDays: [{ day, wasted, runs, spentUsd }], the runs that ended on work not theirs to do",
  auth: true,
  role: "admin",
  refusals: { unauthorized: "no valid credentials were sent", forbidden: "the caller is not a forge admin" },
};
