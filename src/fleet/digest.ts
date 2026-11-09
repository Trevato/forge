/**
 * What a person saw when they previewed: one short digest of the rows, what
 * each would become, and what was said of it. Apply carries it back and is
 * refused if the rows now plan differently, so nothing is written that was
 * not shown. Plain data in, a string out.
 */

import type { FleetValue } from "../core/fleet_ops.ts";

export interface Shown {
  readonly targetId: string;
  readonly after: FleetValue;
  readonly outcome: string;
}

/** A digest of the plan's rows, in the order given. */
export function digestOf(rows: readonly Shown[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const r of rows) hasher.update(`${r.targetId}\n${r.outcome}\n${JSON.stringify(r.after)}\n`);
  return hasher.digest("hex").slice(0, 32);
}
