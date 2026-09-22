/**
 * A snapshot of a forge: everything that cannot be rebuilt, as files a
 * store holds under one prefix, and a manifest that says what is there.
 *
 * What goes in: the database, copied consistently while the forge runs
 * (`VACUUM INTO`, never a raw copy of a file in WAL mode); the key the
 * database's sealed values need; the SSH host key, which is the forge's
 * identity to every clone; every repository, as one git bundle holding
 * every ref; every app's production data, with any SQLite inside copied
 * the same consistent way and its WAL side-files left out; and the crew's
 * run logs. What stays out is what a boot or a deploy rebuilds: clones,
 * checks, previews, pictures.
 *
 * A snapshot is named by the moment it began, in UTC, so a listing sorts
 * itself. Nothing is compressed or bundled beyond git's own bundles: a
 * restore is reading files back, and a person can read the manifest.
 */

import type { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { envDataDir } from "../apps/data.ts";
import { listApps } from "../core/apps.ts";
import { listEveryRepo } from "../core/repos.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import type { Store } from "./store.ts";

const log = createLog("snapshot");

export const SNAPSHOT_PREFIX = "snapshots/";
/** How many nightly snapshots a store keeps before the oldest go. */
export const KEEP = 14;

export interface SnapshotFile {
  readonly path: string;
  readonly bytes: number;
}

export interface Manifest {
  readonly name: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly version: string;
  readonly repos: number;
  readonly apps: number;
  readonly files: readonly SnapshotFile[];
  readonly bytes: number;
}

export interface Snapshotter {
  readonly db: Database;
  readonly dataDir: string;
  readonly reposRoot: string;
  readonly version: string;
}

/** `2026-09-22T09-00-00Z`: sortable, and a name a bucket allows. */
export const snapshotName = (at: Date): string =>
  at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");

const SQLITE = /\.(db|sqlite|sqlite3)$/;
const SIDE_FILE = /\.(db|sqlite|sqlite3)-(wal|shm|journal)$/;

/** A consistent copy of a SQLite file, made by SQLite itself. */
async function vacuumInto(source: string, target: string): Promise<void> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(source, { readonly: true });
  try {
    db.run("VACUUM INTO ?1", [target]);
  } finally {
    db.close();
  }
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      const s = statSync(p, { throwIfNoEntry: false });
      if (s === undefined) continue;
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

export async function takeSnapshot(
  forge: Snapshotter,
  store: Store,
  at = new Date(),
): Promise<Manifest> {
  const name = snapshotName(at);
  const prefix = `${SNAPSHOT_PREFIX}${name}/`;
  const scratch = mkdtempSync(join(tmpdir(), "forge-snapshot-"));
  const files: SnapshotFile[] = [];
  const put = async (
    path: string,
    body: Uint8Array | string,
  ): Promise<void> => {
    await store.put(prefix + path, body);
    files.push({
      path,
      bytes:
        typeof body === "string" ? Buffer.byteLength(body) : body.byteLength,
    });
  };
  const putFile = async (path: string, file: string): Promise<void> => {
    const f = Bun.file(file);
    if (!(await f.exists())) return;
    await put(path, new Uint8Array(await f.arrayBuffer()));
  };
  try {
    // The database, consistently, from the live connection.
    const dbCopy = join(scratch, "forge.db");
    forge.db.run("VACUUM INTO ?1", [dbCopy]);
    await putFile("forge.db", dbCopy);
    await putFile("secret.key", join(forge.dataDir, "secret.key"));
    for (const f of filesUnder(join(forge.dataDir, "ssh")))
      await putFile(`ssh/${f}`, join(forge.dataDir, "ssh", f));

    // Every repository as a bundle of every ref: one file, one git command,
    // consistent by git's own reading of the refs.
    const repos = listEveryRepo(forge.db);
    let bundled = 0;
    for (const repo of repos) {
      const dir = repoDir(forge.reposRoot, repo.ownerName, repo.name);
      const bundle = join(scratch, `${repo.ownerName}--${repo.name}.bundle`);
      const made = await runGit(["bundle", "create", bundle, "--all"], {
        cwd: dir,
      });
      if (!made.ok) {
        // An empty repository has nothing to bundle; git refuses, rightly.
        log.info("repository not bundled", {
          repo: `${repo.ownerName}/${repo.name}`,
          why: made.error.stderr.split("\n")[0] ?? `exit ${made.error.code}`,
        });
        continue;
      }
      await putFile(`repos/${repo.ownerName}/${repo.name}.bundle`, bundle);
      rmSync(bundle, { force: true });
      bundled++;
    }

    // Every app's production data. SQLite inside is copied the consistent
    // way; its side-files are the live process's and not part of a copy.
    const apps = listApps(forge.db);
    let kept = 0;
    for (const app of apps) {
      const dir = envDataDir(forge.dataDir, app.id, "production");
      const inside = filesUnder(dir);
      if (inside.length === 0) continue;
      kept++;
      for (const f of inside) {
        if (SIDE_FILE.test(f)) continue;
        const source = join(dir, f);
        if (SQLITE.test(f)) {
          const copy = join(
            scratch,
            `app-${app.id}-${f.replace(/[\/\\]/g, "__")}`,
          );
          try {
            await vacuumInto(source, copy);
            await putFile(`apps/${app.id}/production/data/${f}`, copy);
          } catch (error) {
            log.warn("app database not copied consistently; copied as a file", {
              app: app.slug,
              file: f,
              error: String(error),
            });
            await putFile(`apps/${app.id}/production/data/${f}`, source);
          } finally {
            rmSync(copy, { force: true });
          }
        } else await putFile(`apps/${app.id}/production/data/${f}`, source);
      }
    }

    // The crew's run logs: history a person may want back.
    for (const f of filesUnder(join(forge.dataDir, "runs")))
      await putFile(`runs/${f}`, join(forge.dataDir, "runs", f));

    const manifest: Manifest = {
      name,
      startedAt: at.toISOString(),
      finishedAt: new Date().toISOString(),
      version: forge.version,
      repos: bundled,
      apps: kept,
      files,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
    };
    await store.put(
      `${prefix}manifest.json`,
      JSON.stringify(manifest, null, 2),
    );
    log.info("snapshot taken", {
      name,
      where: store.where,
      repos: bundled,
      apps: kept,
      files: files.length,
      mb: (manifest.bytes / 1_048_576).toFixed(1),
    });
    return manifest;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The snapshots a store holds, newest first, by their manifests. Names
 * first, then one manifest each: a snapshot is ten thousand objects, and a
 * page that walked them all to find fourteen manifests would be slow in a
 * month and slower every month after.
 */
export async function listSnapshots(store: Store): Promise<Manifest[]> {
  const names = await store.names(SNAPSHOT_PREFIX);
  const out: Manifest[] = [];
  for (const name of names) {
    const body = await store.get(`${SNAPSHOT_PREFIX}${name}/manifest.json`);
    if (body === undefined) continue;
    try {
      const m = JSON.parse(new TextDecoder().decode(body)) as Partial<Manifest>;
      // A manifest that does not read whole is a snapshot that did not
      // finish, or is not one of ours; the page never trips on it.
      if (typeof m.name === "string" && Array.isArray(m.files))
        out.push(m as Manifest);
    } catch {
      // Not JSON: the same.
    }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

/** Delete every snapshot past the newest `keep`. Returns what went. */
export async function pruneSnapshots(
  store: Store,
  keep = KEEP,
): Promise<string[]> {
  const names = (await store.names(SNAPSHOT_PREFIX)).sort().reverse();
  const gone = names.slice(keep);
  for (const name of gone)
    for (const key of await store.list(`${SNAPSHOT_PREFIX}${name}/`))
      await store.delete(key);
  if (gone.length > 0)
    log.info("snapshots pruned", { gone: gone.length, kept: keep });
  return gone;
}
