import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/schedules`,
  summary: "An app's schedules, one row each: cron, timezone, path, paused, next run and last run (status, attempts, duration, lateness, error, the first 2 KB of the response); ?runs=N adds the newest N runs, ?name= narrows them; a reader's; 404 for anyone else",
  auth: true,
  role: "member",
  query: { runs: { type: "integer", min: 1, max: 100 }, name: "the schedule whose runs to list" },
};
