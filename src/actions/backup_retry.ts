/**
 * The retry the off-box backup alarm offers (#10924), for both doors: one
 * snapshot now through `snapshotNow`, then the truth about the alarm. A
 * snapshot that landed in a directory on this machine does not count as off-box,
 * and the answer says so instead of reporting a success the card contradicts.
 */

import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { isOffBox } from "../snapshot/off_box.ts";
import { snapshotsOf } from "../snapshot/service.ts";
import { snapshotNow } from "./backups_now.ts";

export interface BackupRetry {
  /** False when the card will still stand: the snapshot failed, or it did not leave the machine. */
  readonly cleared: boolean;
  /** The refusal code, when the actor may not; otherwise absent. */
  readonly refused?: "not_found";
  readonly says: string;
}

export async function retryBackup(app: App, actor: User | undefined): Promise<BackupRetry> {
  const taken = await snapshotNow(app, actor);
  if (!taken.ok) return { cleared: false, ...(taken.error.code === "not_found" ? { refused: "not_found" as const } : {}), says: taken.error.says };
  const store = snapshotsOf(app)?.store;
  if (store !== undefined && !isOffBox(store))
    return { cleared: false, says: `${taken.value.says} It stayed on this machine, so it is not an off-box backup; the card clears when the mirror or a bucket destination holds a new one.` };
  return { cleared: true, says: taken.value.says };
}
