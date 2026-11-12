/**
 * The radar's night (#9592): for every repository with pinned packages, read
 * upstream and file the updates worth taking (`flows/file.ts`). In-process,
 * no cell: the registry lookup is the only outbound call. Returns one
 * sentence for the nightly record.
 */

import type { App } from "../app.ts";
import { getRepoById } from "../core/repos.ts";
import { fileUpdates } from "../flows/file.ts";
import { npmLookup, readRadar, refreshRadar, type Lookup } from "../flows/radar.ts";
import { pinsOf } from "../flows/run.ts";
import { createLog } from "../kernel/log.ts";
import type { Slot } from "./slots.ts";

const log = createLog("nightly");

/** Where the radar sits among the nights, after the others have finished. */
export const RADAR_SLOT: Slot = { hour: 5, minute: 7 };
export const RADAR_NAME = "radar";

export async function radarNight(app: App, lookup: Lookup = npmLookup, signal?: AbortSignal): Promise<string> {
  const ids = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE archived_at IS NULL ORDER BY id").all();
  let repos = 0;
  const filed: string[] = [];
  for (const { id } of ids) {
    if (signal?.aborted) break;
    const repo = getRepoById(app.db, id);
    if (repo === undefined) continue;
    try {
      const pins = await pinsOf(app, repo);
      if (pins.length === 0) continue;
      repos++;
      await refreshRadar(app.db, repo.id, pins, lookup);
      for (const n of fileUpdates(app, repo, readRadar(app.db, repo.id, pins))) filed.push(`${repo.ownerName}/${repo.name}#${n}`);
    } catch (error) {
      log.warn("radar failed for a repository", { repo: id, error: String(error) });
    }
  }
  return `read ${repos} repositor${repos === 1 ? "y" : "ies"}; ${filed.length === 0 ? "filed nothing" : `filed ${filed.join(", ")}`}.`;
}
