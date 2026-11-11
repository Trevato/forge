/**
 * The "paid, not made" flow alarm (#11138): someone paid for a forge and it
 * could not be made (no room, the name taken in a race). Fires from the
 * moment the order failed until an admin retries it into a forge. Names the
 * oldest, so the one who has waited longest is the one shown.
 */

import type { Database } from "bun:sqlite";

export interface PaidOrderAlarm {
  readonly fired: boolean;
  readonly since?: string;
  readonly says: string;
}

export function alarmPaidOrder(db: Database): PaidOrderAlarm {
  const rows = db
    .query<{ name: string; reason: string; updated_at: number }, []>("SELECT name, reason, updated_at FROM forge_order WHERE state = 'failed' ORDER BY updated_at ASC")
    .all();
  const first = rows[0];
  if (first === undefined) return { fired: false, says: "Every paid order has its forge." };
  const more = rows.length > 1 ? ` (and ${rows.length - 1} more)` : "";
  return { fired: true, since: new Date(first.updated_at).toISOString(), says: `A buyer paid for ${first.name} and it could not be made: ${first.reason}${more}.` };
}
