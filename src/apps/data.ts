/**
 * Where an environment keeps its state, and how a preview gets a copy of
 * production's.
 *
 * Every environment owns exactly one directory and is handed it as
 * `FORGE_APP_DATA`. Production's lives as long as the app; a preview's is
 * created when the pull opens and removed when it closes. A preview starts
 * from a *copy* of production data — never a view of it — taken at the
 * moment the preview is created: on APFS, XFS and btrfs the copy is
 * copy-on-write (bytes are shared until either side writes), elsewhere it is
 * a plain copy. Both are the same guarantee at different speeds.
 *
 * SQLite in WAL mode keeps recent writes in a `-wal` file beside the
 * database. Copying the pair mid-write can produce a database whose WAL
 * belongs to a different moment, so every SQLite file is checkpointed into
 * its main file first. The app under test is still running; WAL is designed
 * for exactly that.
 */

import { Database } from "bun:sqlite";
import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { defect } from "../kernel/error.ts";

/**
 * `production`, `pull-<n>` for the preview of pull `n`, or `build-<sha7>`
 * for a build preview: one commit a writer asked to see now, short-lived.
 */
export type EnvName = "production" | `pull-${number}` | `build-${string}`;

export const previewEnv = (pullNumber: number): EnvName => `pull-${pullNumber}`;

/** A build preview's name: the commit's short sha, `build-1a2b3c4`. */
export const buildEnv = (oid: string): EnvName => `build-${oid.slice(0, 7).toLowerCase()}`;

/** The short sha a build preview serves; `undefined` for any other environment. */
export function envBuild(env: EnvName): string | undefined {
  return /^build-[0-9a-f]{7}$/.test(env) ? env.slice(6) : undefined;
}

export function isEnvName(value: string): value is EnvName {
  return (
    value === "production" ||
    /^pull-[1-9]\d*$/.test(value) ||
    /^build-[0-9a-f]{7}$/.test(value)
  );
}

/** The pull a preview environment belongs to; `undefined` for production and a build. */
export function envPull(env: EnvName): number | undefined {
  return env.startsWith("pull-") ? Number(env.slice(5)) : undefined;
}

/**
 * What follows the slug in an environment's hostname label and its ssh
 * login: nothing for production, `--<n>` for a preview, or
 * `--b<sha7>` for a build preview. One rule builds both, and
 * `parseAppHost` reads it back.
 */
export function envHostLabel(slug: string, env: EnvName): string {
  if (env === "production") return slug;
  const build = envBuild(env);
  if (build !== undefined) return `${slug}--b${build}`;
  return `${slug}--${env.slice(5)}`;
}

/**
 * A host label's tail read back as a build preview: `b1a2b3c4` →
 * `build-1a2b3c4`. Slugs of that shape are reserved (`core/apps.ts`), so
 * the tail is never an app.
 */
export function buildEnvFromLabel(tail: string): EnvName | undefined {
  return /^b[0-9a-f]{7}$/.test(tail) ? `build-${tail.slice(1)}` : undefined;
}

/** An environment as a person reads its name: production, the preview of #n, or the build at <sha7>. */
export function envWords(env: EnvName): string {
  if (env === "production") return "production";
  const build = envBuild(env);
  if (build !== undefined) return `the build at ${build}`;
  return `the preview of #${env.slice(5)}`;
}

export const appsRoot = (dataDir: string): string => join(dataDir, "apps");

/**
 * An environment's directory. The names are checked here as well as at
 * every call site: a path under `<data>/apps` is built from exactly an id
 * and an environment name, and anything else is a bug, loudly.
 */
export function envDir(dataDir: string, appId: string, env: EnvName): string {
  if (!isEnvName(env) || !/^[0-9a-z]+$/i.test(appId))
    defect("apps.bad_env_path", `refusing to build a path for ${appId}/${env}`);
  return join(appsRoot(dataDir), appId, env);
}

export const envDataDir = (
  dataDir: string,
  appId: string,
  env: EnvName,
): string => join(envDir(dataDir, appId, env), "data");

export type PreviewData = "copy" | "empty";

export type SeedOutcome = "cloned" | "copied" | "empty";

/**
 * Create an environment's data directory. A preview with `policy: "copy"`
 * starts as production's data at this moment; anything else starts empty.
 * Idempotent: an existing directory is left exactly as it is, because a
 * redeploy of the same preview must keep the state the reviewer built up.
 */
export function ensureEnvData(
  dataDir: string,
  appId: string,
  env: EnvName,
  policy: PreviewData,
): SeedOutcome | "kept" {
  const target = envDataDir(dataDir, appId, env);
  if (existsSync(target)) return "kept";
  if (env === "production" || policy === "empty") {
    mkdirSync(target, { recursive: true });
    return "empty";
  }
  const source = envDataDir(dataDir, appId, "production");
  if (!existsSync(source)) {
    mkdirSync(target, { recursive: true });
    return "empty";
  }
  quiesceSqlite(source);
  mkdirSync(join(target, ".."), { recursive: true });
  return cloneDir(source, target);
}

/**
 * Discard a data directory that turned out to be unusable and recreate it
 * empty. Used only after a copy has already been tried and its process
 * would not come up: the copy is not kept beside the fresh directory, and
 * nothing outside this one environment's data directory is touched.
 */
export function reseedEmpty(dataDir: string, appId: string, env: EnvName): void {
  const target = envDataDir(dataDir, appId, env);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
}

/** Remove an environment entirely: checkouts, data, everything. */
export function removeEnv(dataDir: string, appId: string, env: EnvName): void {
  rmSync(envDir(dataDir, appId, env), { recursive: true, force: true });
}

/** Remove an app's whole directory — every environment with it. */
export function removeApp(dataDir: string, appId: string): void {
  rmSync(join(appsRoot(dataDir), appId), { recursive: true, force: true });
}

/**
 * Copy a directory, sharing blocks when the filesystem can. `FICLONE_FORCE`
 * either clones or refuses — it never silently degrades — so a refusal is
 * the signal to fall back to a byte copy, and the caller learns which
 * happened. Only what a copy can carry comes along: directories, files and
 * links. A socket or a pipe an app left in its data belongs to the process
 * that made it, not to the data, and opening one to copy it is an error.
 * The copy lands beside the target and is renamed into place whole, so a
 * copy that fails part-way leaves nothing a later deploy could keep as if
 * it were complete.
 */
export function cloneDir(source: string, target: string): SeedOutcome {
  const staging = `${target}.copying`;
  rmSync(staging, { recursive: true, force: true });
  let outcome: SeedOutcome;
  try {
    try {
      cpSync(source, staging, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE_FORCE,
        filter: copyable,
      });
      outcome = "cloned";
    } catch {
      rmSync(staging, { recursive: true, force: true });
      cpSync(source, staging, { recursive: true, filter: copyable });
      outcome = "copied";
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  renameSync(staging, target);
  return outcome;
}

function copyable(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
}

const SQLITE_MAGIC = "SQLite format 3\0";
const MAX_FILES = 10_000;

/**
 * Checkpoint every SQLite database under `dir` so its WAL is folded into the
 * main file before it is copied. Databases are recognised by their header,
 * not their name, because an app may call its file anything. Bounded by file
 * count: a data directory is not a place to walk forever.
 */
export function quiesceSqlite(dir: string): void {
  let seen = 0;
  const walk = (path: string): void => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_FILES) return;
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isSqlite(full)) checkpoint(full);
    }
  };
  walk(dir);
}

function isSqlite(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(SQLITE_MAGIC.length);
    const read = readSync(fd, header, 0, header.length, 0);
    return read === header.length && header.toString("latin1") === SQLITE_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function checkpoint(path: string): void {
  let db: Database | undefined;
  try {
    db = new Database(path, { readwrite: true });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // A database another process holds exclusively, or one that is not
    // really SQLite despite its header: the copy proceeds without it.
  } finally {
    db?.close();
  }
}
