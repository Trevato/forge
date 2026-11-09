/**
 * The SQLite files a viewer may see: the forge's own (admins), and each
 * app's per environment (people who can write the app's repository). An id
 * is only ever resolved by looking it up in this list, so no input becomes
 * a path.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listApps } from "../core/apps.ts";
import { getRepoById, writableRepoIds } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { envDataDir, isEnvName } from "../apps/data.ts";

export interface Source {
  /** `forge`, or `app:<appId>:<env>:<file>`. */
  readonly id: string;
  readonly label: string;
  readonly kind: "forge" | "app";
  readonly path: string;
}

const DB_FILE = /^[\w.-]+\.db$/;

export function listSources(
  db: Database,
  dataDir: string,
  viewer: User | undefined,
): Source[] {
  const out: Source[] = [];
  if (viewer === undefined) return out;
  if (viewer.isAdmin) {
    const path = join(dataDir, "forge.db");
    if (existsSync(path))
      out.push({ id: "forge", label: "forge", kind: "forge", path });
  }
  const apps = listApps(db);
  const writable = writableRepoIds(
    db,
    viewer,
    apps.map((a) => a.repoId),
  );
  for (const app of apps) {
    if (!writable.has(app.repoId) || getRepoById(db, app.repoId) === undefined)
      continue;
    let envs: string[];
    try {
      envs = readdirSync(join(dataDir, "apps", app.id)).filter(isEnvName);
    } catch {
      continue;
    }
    for (const env of envs.sort()) {
      if (!isEnvName(env)) continue;
      const dir = envDataDir(dataDir, app.id, env);
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => DB_FILE.test(f));
      } catch {
        continue;
      }
      for (const file of files.sort())
        out.push({
          id: `app:${app.id}:${env}:${file}`,
          label: `${app.slug} · ${env} · ${file}`,
          kind: "app",
          path: join(dir, file),
        });
    }
  }
  return out;
}

/**
 * Whether the viewer has a door to the data browser at all: an admin, or a
 * writer of an app, whether or not any database file exists yet. A guest and
 * a reader have none (a 404 on the web, no entry in the terminal).
 */
export function maySeeData(db: Database, viewer: User | undefined): boolean {
  if (viewer === undefined) return false;
  if (viewer.isAdmin) return true;
  const ids = listApps(db).map((a) => a.repoId);
  return ids.length > 0 && writableRepoIds(db, viewer, ids).size > 0;
}

/** The source `id` names, if this viewer may see it; else `undefined` (a 404). */
export const findSource = (
  db: Database,
  dataDir: string,
  viewer: User | undefined,
  id: string,
): Source | undefined =>
  listSources(db, dataDir, viewer).find((s) => s.id === id);
