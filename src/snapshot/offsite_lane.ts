/**
 * The forge's off-site backup lane in one reading (#11805): the mirror pass
 * the forge runs in its own process, where it writes, whether what it writes
 * is sealed, when it last succeeded, and the last restore drill and where
 * that drill restored from. `/system` shows it.
 *
 * `/system`, its terminal screen (`src/tui/screens/offsite.ts`) and the MCP
 * `system` tool (`kind: offsite`) all read it through `readOffsiteLane`.
 *
 * Plain data in (the mirror's kept state and the last drill), plain data
 * out; no network, no clock but the one given.
 */

import type { Database } from "bun:sqlite";
import type { DrillResult } from "./drill.ts";
import { lastDrill } from "./drills.ts";
import { lastMirror, MIRROR_STALE_MS, type MirrorState } from "./mirror.ts";

export type LaneHealth = "none" | "ok" | "late" | "failing" | "unsealed";

export interface OffsiteLane {
  readonly health: LaneHealth;
  /** The lane's bucket (`host/bucket`), never a key; null when the forge has no off-site lane. */
  readonly where: string | null;
  readonly sealed: boolean;
  /** The last pass that left the lane level with the newest snapshot. */
  readonly lastSuccess: string | null;
  /** The newest snapshot the lane holds. */
  readonly newest: string | null;
  /** Why passes are failing now, one line. */
  readonly error: string | null;
  readonly drill: {
    readonly at: string;
    readonly verdict: "green" | "red";
    readonly from: string | null;
    readonly offSite: boolean;
    readonly reason: string | null;
  } | null;
}

export function offsiteLane(state: MirrorState | undefined, drill: DrillResult | undefined, now: number): OffsiteLane {
  const drillSeen = drill === undefined
    ? null
    : { at: drill.at, verdict: drill.verdict, from: drill.from ?? null, offSite: drill.offSite === true, reason: drill.reason };
  if (state === undefined)
    return { health: "none", where: null, sealed: false, lastSuccess: null, newest: null, error: null, drill: drillSeen };
  const sealed = state.sealed === true;
  const synced = Date.parse(state.syncedAt ?? "");
  // A lane without the passphrase refuses every write (#11805); that, not its failing passes, is what to fix.
  const health: LaneHealth =
    !sealed ? "unsealed"
    : state.failingSince !== undefined ? "failing"
    : !Number.isFinite(synced) || now - synced > MIRROR_STALE_MS ? "late"
    : "ok";
  return {
    health,
    where: state.where,
    sealed,
    lastSuccess: state.syncedAt ?? null,
    newest: state.newest ?? null,
    error: state.failingSince === undefined ? null : (state.error ?? "unknown reason"),
    drill: drillSeen,
  };
}

/** The lane now, from what the last pass and the last drill kept: one small file and one row, no network. */
export function readOffsiteLane(dataDir: string, db: Database, now = Date.now()): OffsiteLane {
  return offsiteLane(lastMirror(dataDir), lastDrill(db), now);
}

/** One sentence for the lane, as `/system` heads it. */
export function laneWords(l: OffsiteLane): string {
  switch (l.health) {
    case "none":
      return "No off-site lane: set FORGE_MIRROR_S3_* (or seal a mirror on the Backups page) and FORGE_SNAPSHOT_PASSPHRASE.";
    case "failing":
      return `The off-site lane is failing: ${l.error}.`;
    case "late":
      return "The off-site lane has not succeeded for over a day.";
    case "unsealed":
      return "The off-site lane writes nothing until FORGE_SNAPSHOT_PASSPHRASE is set: it never writes unsealed.";
    case "ok":
      return "The off-site lane is level and sealed.";
  }
}
