/** Visitor rows not seen for 13 months are deleted (#11265); see `perf/visitor_store.ts`. */

import type { Duty } from "../duty.ts";
import { purgeVisitors } from "../../perf/visitor_store.ts";

export const duty: Duty = {
  name: "visitor-retention",
  intervalMs: 86_400_000,
  run({ db, now }) {
    const removed = purgeVisitors(db, now.getTime());
    return { findings: [], actions: removed === 0 ? [] : [`deleted ${removed} visitor rows older than 13 months`] };
  },
};
