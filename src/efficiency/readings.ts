/** What each cause reads right now, from the figures the forge already keeps (#7546's egress tally, the 15 s machine sampler). */

import type { Database } from "bun:sqlite";
import { hitRateLastHour } from "./installs.ts";
import { egressTotals, NPM_REGISTRY } from "../apps/egress.ts";

export type Readings = Readonly<Record<string, number>>;

/** CPU-seconds the machine used over the hour up to `now`: mean cores of the 15 s points times 3600. */
export function cpuSecondsLastHour(db: Database, now: number): number | undefined {
  const r = db
    .query("SELECT AVG(cpu_cores) AS cores FROM machine_sample WHERE target = 'node' AND step = 15 AND cpu_cores IS NOT NULL AND at > ?1")
    .get(new Date(now - 3_600_000).toISOString()) as { cores: number | null } | null;
  return r?.cores == null ? undefined : r.cores * 3600;
}

export function readNow(db: Database, now: number): Readings {
  const totals = egressTotals(now);
  const out: Record<string, number> = {
    "npm-registry-bytes": totals.find((t) => t.destination === NPM_REGISTRY)?.bytesInLastHour ?? 0,
    "egress-other-bytes": totals.filter((t) => t.destination !== NPM_REGISTRY).reduce((n, t) => n + t.bytesInLastHour, 0),
  };
  const cpu = cpuSecondsLastHour(db, now);
  if (cpu !== undefined) out["cpu-seconds"] = cpu;
  const hit = hitRateLastHour(now);
  if (hit !== undefined) out["install-cache-hit-rate"] = hit;
  return out;
}
