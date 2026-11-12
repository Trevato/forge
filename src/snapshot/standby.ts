/**
 * A snapshot restored for a read-only standby (#9657): the restore of
 * `restore.ts` into an empty directory, then checked — the database passes
 * SQLite's integrity check and every repository the database lists is a
 * directory on disk. Plain data out; the script prints it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoDir } from "../git/repos.ts";
import { restoreSnapshot, type Restored } from "./restore.ts";
import { listSnapshots } from "./snapshot.ts";
import type { Store } from "./store.ts";

export interface Standby {
  readonly name: string;
  readonly restored: Restored;
  /** Repositories the database lists. */
  readonly repos: number;
  /** What failed the verification, one line each; empty is verified. */
  readonly problems: readonly string[];
}

/** The database's integrity and its repositories, checked in a restored directory. */
export async function verifyRestored(dataDir: string): Promise<{ repos: number; problems: string[] }> {
  const { Database } = await import("bun:sqlite");
  const file = join(dataDir, "forge.db");
  if (!existsSync(file)) return { repos: 0, problems: ["forge.db is missing"] };
  const db = new Database(file, { readonly: true });
  try {
    const problems: string[] = [];
    const rows = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
      problems.push(`integrity check: ${rows.map((r) => r.integrity_check).slice(0, 3).join("; ")}`);
    const repos = db
      .query<{ owner: string; name: string }, []>(
        "SELECT u.username AS owner, r.name AS name FROM repo r JOIN user u ON u.id = r.owner_id",
      )
      .all();
    const missing = repos.filter((r) => !existsSync(repoDir(join(dataDir, "repos"), r.owner, r.name)));
    for (const r of missing.slice(0, 5)) problems.push(`repository ${r.owner}/${r.name} is not on disk`);
    if (missing.length > 5) problems.push(`and ${missing.length - 5} more repositories not on disk`);
    return { repos: repos.length, problems };
  } finally {
    db.close();
  }
}

/** `name` is a snapshot name or `latest`; the directory must be empty. */
export async function restoreStandby(
  store: Store,
  name: string,
  dataDir: string,
  passphrase?: string,
): Promise<Standby> {
  let chosen = name;
  if (name === "latest") {
    const newest = (await listSnapshots(store))[0];
    if (newest === undefined) throw new Error(`no snapshot in ${store.where}`);
    chosen = newest.name;
  }
  const restored = await restoreSnapshot(store, chosen, dataDir, { passphrase });
  const checked = await verifyRestored(dataDir);
  return { name: chosen, restored, repos: checked.repos, problems: checked.problems };
}
