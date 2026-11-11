/** Example duty (#11204): how many open pulls have waited over 24 hours. Reads only. */

import type { Duty } from "../duty.ts";

const DAY_MS = 24 * 3_600_000;
const SQL = "SELECT COUNT(*) AS n FROM issue WHERE kind = 'pull' AND state = 'open' AND parked = 0 AND created_at < ?1";

export const duty: Duty = {
  name: "pulls-waiting",
  intervalMs: 3_600_000,
  run({ db, now }) {
    const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
    const n = (db.query(SQL).get(cutoff) as { n: number }).n;
    if (n === 0) return { findings: [], actions: [] };
    return {
      findings: [
        {
          summary: `${n} open pull${n === 1 ? "" : "s"} waiting over 24 hours`,
          probe: { kind: "query", what: SQL.replace("?1", `'${cutoff}'`), number: n, at: now.toISOString() },
        },
      ],
      actions: [],
    };
  },
};
