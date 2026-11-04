/**
 * A week the provider has measured but whose pace does not apply yet: the
 * reset lies more than a week off, so `weekDecision` has nothing to say and
 * the crew keeps its slots (#8960). For tests about something other than
 * pacing, which would otherwise hold at the unknown-week level.
 */
import type { Database } from "bun:sqlite";
import { noteMeasure } from "../../src/core/measure.ts";

export function quietWeek(db: Database): void {
  const ids = db.query<{ id: string }, []>("SELECT id FROM subscription").all().map((r) => r.id);
  for (const id of new Set(["platform", ...ids]))
    noteMeasure(db, id, { window: "week", usedPct: 10, resetsAt: "2100-01-01T00:00:00.000Z", observedAt: new Date().toISOString() });
}
