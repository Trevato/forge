/**
 * The one line on backups that /resilience and the terminal's Resilience
 * dialog both say: where snapshots go, or that they are off here and why.
 * Plain text from the store this process holds; never the store's secrets
 * (`Store.where` is the store's own page-safe name for itself).
 */

import type { App } from "../app.ts";
import { snapshotsOf } from "./service.ts";

export const BACKUPS_OFF = "Backups are off here: this forge was given no bucket to keep snapshots in.";

/** `where` is set only when a store is in effect and names itself. */
export type BackupsLine = { readonly where?: string; readonly says: string };

/**
 * A store whose `where` is empty counts as none: no store builds one today
 * (a bucket's is `s3://…`, a directory's its path), but a line saying
 * "Snapshots go to ." would be worse than saying they are off.
 */
export function backupsLineOf(store: { readonly where: string } | undefined): BackupsLine {
  const where = store?.where.trim() ?? "";
  return where === "" ? { says: BACKUPS_OFF } : { where, says: `Snapshots go to ${where}.` };
}

export const backupsLine = (app: App): BackupsLine => backupsLineOf(snapshotsOf(app)?.store);
