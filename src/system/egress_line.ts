/**
 * The one sentence for a forge whose cells' egress is reported, not enforced
 * (#10699). Capacity, System and both terminal screens say exactly this and no
 * more; null when egress is enforced, so a healthy forge says nothing.
 */
import type { Database } from "bun:sqlite";
import { egressSetting } from "../core/capacity.ts";

export const EGRESS_REPORTED = "Egress is reported, not enforced: cells may reach any public host on ports 80 and 443.";

export function egressReportedLine(db: Database): string | null {
  return egressSetting(db) === "report" ? EGRESS_REPORTED : null;
}
