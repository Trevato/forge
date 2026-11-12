/** The efficiency watcher (#7558): hourly cost by cause against a 7-day baseline; see `src/efficiency/`. */

import type { Duty } from "../duty.ts";
import { watch } from "../../efficiency/watch.ts";

export const duty: Duty = {
  name: "efficiency-watcher",
  intervalMs: 3_600_000,
  budget: { runsPerDay: 30, dollarsPerDay: 1, reason: "hourly is 24 a day; the rest is room for a catch-up, and it spends no money" },
  run({ app, now }) {
    return app === undefined ? { findings: [], actions: [] } : watch(app, now.getTime());
  },
};
