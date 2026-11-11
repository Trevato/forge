/**
 * The rule watcher (#7560): four reads of the check record, once an interval.
 * The reads live in `src/rules/watch.ts`; this file only calls them in turn.
 * Findings and actions are on `/maintenance` and the terminal's "maintenance
 * duty runs" screen (`src/tui/screens/maintainruns.ts`), as for every duty.
 */

import type { Database } from "bun:sqlite";
import type { Repo } from "../../core/repos.ts";
import { breakers, budgets, flakeWeek, gateOnly, type Watch } from "../../rules/watch.ts";
import type { Duty } from "../duty.ts";
import { lastStarted } from "../runs.ts";

function reposOf(db: Database): Map<string, Pick<Repo, "id" | "ownerId">> {
  const rows = db.query<{ id: string; owner_id: string }, []>("SELECT id, owner_id FROM repo").all();
  return new Map(rows.map((r) => [r.id, { id: r.id, ownerId: r.owner_id }]));
}

export const duty: Duty = {
  name: "rule-watcher",
  intervalMs: 15 * 60_000,
  run({ db, bus, now }) {
    const w: Watch = { db, bus, repos: reposOf(db), now };
    // The runner records this run after it returns, so the last start on record is the previous run's.
    const reads = [breakers(w), gateOnly(w), flakeWeek(w, lastStarted(db, "rule-watcher")), budgets(w)];
    return { findings: reads.flatMap((r) => r.findings), actions: reads.flatMap((r) => r.actions) };
  },
};
