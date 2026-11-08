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
 * itself. Little is compressed or bundled beyond git's own bundles: the
 * crew's older run logs, one compressed bundle per day, because a bucket
 * costs a round trip per object and thousands of tiny logs are one object
 * a day; and the database, compressed and cut in parts (`parts.ts`),
 * because whole it was more than a home uplink carries in one put's
 * deadline. A restore is reading files back, and a person can read the
 * manifest.
 *
 * Objects go up through a bounded queue, eight in flight; the manifest
 * lists them in the order they were handed over, not the order they landed.
 */

import { Database } from "bun:sqlite";
import { vacuumFile, vacuumInto } from "./vacuum.ts";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { envDataDir } from "../apps/data.ts";
import { listApps } from "../core/apps.ts";
import { listEveryRepo } from "../core/repos.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { createLog } from "../kernel/log.ts";
import { countRows, type DrillCounts } from "./counts.ts";
import { pack, partPath, PART_BYTES, type PackedFile } from "./parts.ts";
import type { Store } from "./store.ts";
import { unwrapKey, wrapKey, WRAPPED_KEY } from "./wrap.ts";

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
  /** What the database copy held; the drill checks the restore against it. Absent before the drill compared. */
  readonly counts?: DrillCounts;
  /**
   * What the snapshot carries of the forge's key: `wrapped` under the
   * operator's passphrase, `none` (sealed values are lost on restore), or
   * `raw` in snapshots from before the key was wrapped.
   */
  readonly key?: "wrapped" | "none" | "raw";
  /** Files that went up compressed in parts, each listed in `files` by its parts. Absent before the database was packed. */
  readonly packed?: readonly PackedFile[];
}

/** What a manifest says of the key, including manifests older than the field. */
export const keyOf = (m: Manifest): "wrapped" | "none" | "raw" =>
  m.key ?? (m.files.some((f) => f.path === "secret.key") ? "raw" : "none");

/** How far a running snapshot is. */
export interface Progress {
  readonly objects: number;
  readonly bytes: number;
  readonly elapsedMs: number;
}

/** Puts in flight at once: latency, not bandwidth, was the hour. */
export const IN_FLIGHT = 8;
/** Bytes held in memory by puts in flight; past this the next file waits. */
export const IN_FLIGHT_BYTES = 64 * 1024 * 1024;
/** A progress line every this many objects or this many ms, whichever first. */
export const PROGRESS_OBJECTS = 500;
export const PROGRESS_MS = 60_000;
/** Run logs touched within this long stay one object each; older go in daily bundles. */
export const RUN_WINDOW_MS = 24 * 3_600_000;
/** A bundle is cut before its logs pass this many bytes, so one is never a day's whole history in memory. */
export const BUNDLE_BYTES = 4 * 1_048_576;
const BUNDLE_NAME = /^runs\/\d{4}-\d{2}-\d{2}(-\d+)?\.ndjson\.zst$/;

/** Whether a manifest path is a daily bundle of run logs. */
export const isRunBundle = (path: string): boolean => BUNDLE_NAME.test(path);

/** A bundle's body: one JSON line per log, its body in base64, zstd over all. */
export function packRuns(
  logs: readonly { path: string; body: Uint8Array }[],
): Uint8Array {
  const text = logs
    .map((l) =>
      JSON.stringify({
        path: l.path,
        body: Buffer.from(l.body).toString("base64"),
      }),
    )
    .join("\n");
  return Bun.zstdCompressSync(text);
}

/** The logs in a bundle; paths that would leave the runs directory are refused. */
export function unpackRuns(
  bundle: Uint8Array,
): { path: string; body: Uint8Array }[] {
  const text = new TextDecoder().decode(Bun.zstdDecompressSync(bundle));
  const out: { path: string; body: Uint8Array }[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const entry = JSON.parse(line) as { path?: unknown; body?: unknown };
    if (typeof entry.path !== "string" || typeof entry.body !== "string")
      throw new Error("a run bundle holds a line that is not a log");
    if (
      entry.path === "" ||
      entry.path.startsWith("/") ||
      entry.path.split("/").includes("..")
    )
      throw new Error(`a run bundle names ${entry.path}`);
    out.push({
      path: entry.path,
      body: new Uint8Array(Buffer.from(entry.body, "base64")),
    });
  }
  return out;
}

/** Three tries at one put; the last failure names the key. */
async function withRetries(
  key: string,
  put: () => Promise<void>,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await put();
    } catch (error) {
      failure = error;
      if (attempt < 2) await Bun.sleep(200 * 4 ** attempt);
    }
  }
  throw new Error(`could not put ${key}: ${String(failure)}`);
}

export interface Snapshotter {
  readonly db: Database;
  readonly dataDir: string;
  readonly reposRoot: string;
  readonly version: string;
  /** The operator's wrapping secret; without it the key stays out. */
  readonly passphrase?: string | undefined;
  /** Told every so often how far the upload is; the default writes the progress line to the log. */
  readonly onProgress?: ((p: Progress) => void) | undefined;
  /** Told each time an object lands, for a page that shows the snapshot live. */
  readonly onLand?: ((p: Progress) => void) | undefined;
  /** Overrides of the progress cadence, for tests. */
  readonly progressEvery?: { objects?: number; ms?: number } | undefined;
  /** Override of the database's part size, for tests. */
  readonly partBytes?: number | undefined;
  /**
   * Carry on a snapshot a release cut short: `at` is its start, and the
   * repository bundles and run bundles its journal says landed are not put
   * again. Everything else (the database, the key, live files) is taken anew.
   */
  readonly resume?: boolean | undefined;
  /** Override of how often a changed journal is written, for tests. */
  readonly journalEveryMs?: number | undefined;
}

/** The journal of what landed of a snapshot still being taken; gone once its manifest is. */
export const JOURNAL = "partial.json";
/** The journal is rewritten after this many more objects have landed. */
export const JOURNAL_EVERY = 100;
/** And no later than this after something landed: a release kills the process between writes. */
export const JOURNAL_MS = 15_000;
/** A snapshot cut short is carried on, not retaken, if it began within this long. */
export const RESUME_WINDOW_MS = 24 * 3_600_000;

/** The start a snapshot's name stands for: the inverse of `snapshotName`. */
export function snapshotStart(name: string): Date | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(name);
  if (m === null) return undefined;
  const at = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** Whether a path is written once and never changed after, so a resume may skip it. */
const resumable = (path: string): boolean => path.startsWith("repos/") || isRunBundle(path);

/** What the journal remembers of an object: its size and the digest of its bytes. */
interface Landed {
  readonly bytes: number;
  readonly sha256: string;
}

const digest = (body: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(body).digest("hex");

async function readJournal(store: Store, prefix: string): Promise<Map<string, Landed>> {
  const out = new Map<string, Landed>();
  try {
    const body = await store.get(prefix + JOURNAL);
    if (body === undefined) return out;
    const list = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!Array.isArray(list)) return out;
    for (const e of list as { path?: unknown; bytes?: unknown; sha256?: unknown }[])
      if (typeof e?.path === "string" && typeof e.bytes === "number" && typeof e.sha256 === "string")
        out.set(e.path, { bytes: e.bytes, sha256: e.sha256 });
  } catch {
    // An unreadable journal is no journal: everything goes up again.
  }
  return out;
}

/** `2026-09-22T09-00-00Z`: sortable, and a name a bucket allows. */
export const snapshotName = (at: Date): string =>
  at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");

const SQLITE = /\.(db|sqlite|sqlite3)$/;
const SIDE_FILE = /\.(db|sqlite|sqlite3)-(wal|shm|journal)$/;

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
  const packed: PackedFile[] = [];
  let dbCounts: DrillCounts | undefined;
  const started = Date.now();
  const everyObjects = forge.progressEvery?.objects ?? PROGRESS_OBJECTS;
  const everyMs = forge.progressEvery?.ms ?? PROGRESS_MS;
  const report =
    forge.onProgress ??
    ((p: Progress) =>
      log.info("in progress", {
        objects: p.objects,
        bytes: p.bytes,
        elapsed: `${Math.round(p.elapsedMs / 1000)}s`,
      }));
  let landed = 0;
  let landedBytes = 0;
  let sinceReport = 0;
  const say = (): void => {
    sinceReport = 0;
    report({
      objects: landed,
      bytes: landedBytes,
      elapsedMs: Date.now() - started,
    });
  };
  const ticker = setInterval(say, everyMs);
  const pending = new Set<Promise<void>>();
  const before = forge.resume ? await readJournal(store, prefix) : new Map<string, Landed>();
  const journal = new Map<string, Landed>();
  let journaled = 0;
  let unwritten = false;
  let writing: Promise<void> = Promise.resolve();
  let finished = false;
  // Best effort: a journal not written costs a retake of some objects.
  const writeJournal = (): void => {
    journaled = 0;
    unwritten = false;
    const body = JSON.stringify([...journal].map(([path, l]) => ({ path, ...l })));
    writing = writing.then(() => store.put(prefix + JOURNAL, body)).catch(() => {});
  };
  // A release kills the process without running a `finally`: what landed must
  // already be written, so a changed journal goes out on a clock too.
  const journalTicker = setInterval(() => {
    if (unwritten) writeJournal();
  }, forge.journalEveryMs ?? JOURNAL_MS);
  const remember = (path: string, l: Landed): void => {
    journal.set(path, l);
    unwritten = true;
    // The first object landed is journaled at once; then every N more.
    if (journal.size === 1 || ++journaled >= JOURNAL_EVERY) writeJournal();
  };
  let failure: Error | undefined;
  let held = 0;
  // Hands an object to the queue: waits for a free slot, then lets the put
  // run on its own while the caller reads the next file.
  const put = async (
    path: string,
    body: Uint8Array | string,
  ): Promise<void> => {
    const bytes =
      typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    while (
      (pending.size >= IN_FLIGHT ||
        (pending.size > 0 && held + bytes > IN_FLIGHT_BYTES)) &&
      failure === undefined
    )
      await Promise.race(pending);
    if (failure !== undefined) throw failure;
    files.push({ path, bytes });
    const sha256 = resumable(path) ? digest(body) : "";
    const had = before.get(path);
    if (had !== undefined && had.bytes === bytes && had.sha256 === sha256) {
      journal.set(path, had);
      landed++;
      landedBytes += bytes;
      return;
    }
    held += bytes;
    const run: Promise<void> = withRetries(prefix + path, () =>
      store.put(prefix + path, body),
    )
      .then(
        () => {
          landed++;
          landedBytes += bytes;
          if (resumable(path)) remember(path, { bytes, sha256 });
          forge.onLand?.({
            objects: landed,
            bytes: landedBytes,
            elapsedMs: Date.now() - started,
          });
          if (++sinceReport >= everyObjects) say();
        },
        (error) => {
          failure ??= error as Error;
        },
      )
      .finally(() => {
        held -= bytes;
        pending.delete(run);
      });
    pending.add(run);
  };
  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all([...pending]);
    if (failure !== undefined) throw failure;
  };
  const putFile = async (path: string, file: string): Promise<void> => {
    const f = Bun.file(file);
    if (!(await f.exists())) return;
    await put(path, new Uint8Array(await f.arrayBuffer()));
  };
  try {
    // The database, consistently, from the live connection.
    const dbCopy = join(scratch, "forge.db");
    await vacuumInto(forge.db, dbCopy);
    const copy = new Database(dbCopy, { readonly: true });
    try {
      dbCounts = countRows(copy);
    } catch {
      // A database that cannot be counted is the drill's to find; the snapshot still goes up.
    } finally {
      copy.close();
    }
    // Compressed and in parts: each part one put, with its own deadline and
    // retries, so a slow uplink carries it and a dropped one costs a part.
    const database = await pack(
      "forge.db",
      new Uint8Array(await Bun.file(dbCopy).arrayBuffer()),
      forge.partBytes ?? PART_BYTES,
    );
    packed.push(database.packed);
    log.info("database packed", {
      mb: (database.packed.bytes / 1_048_576).toFixed(1),
      packedMb: (database.packed.packedBytes / 1_048_576).toFixed(1),
      ratio: (database.packed.bytes / Math.max(1, database.packed.packedBytes)).toFixed(2),
      parts: database.packed.parts,
    });
    for (const [n, part] of database.parts.entries())
      await put(partPath("forge.db", n), part);
    rmSync(dbCopy, { force: true });
    // The key travels only wrapped. Without a passphrase it stays home.
    let key: Manifest["key"] = "none";
    const keyFile = Bun.file(join(forge.dataDir, "secret.key"));
    if (forge.passphrase && (await keyFile.exists())) {
      const raw = new Uint8Array(await keyFile.arrayBuffer());
      const wrapped = wrapKey(raw, forge.passphrase);
      if (unwrapKey(wrapped, forge.passphrase) === undefined)
        throw new Error("the wrapped key does not open; snapshot abandoned");
      await put(WRAPPED_KEY, wrapped);
      key = "wrapped";
    }
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
            await vacuumFile(source, copy);
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

    // The crew's run logs: history a person may want back. Recent ones go
    // up as they are; older ones, a day's worth to an object.
    const runsDir = join(forge.dataDir, "runs");
    const days = new Map<string, { path: string; size: number }[]>();
    for (const f of filesUnder(runsDir)) {
      const file = join(runsDir, f);
      const age = statSync(file, { throwIfNoEntry: false });
      if (age === undefined) continue;
      if (Date.now() - age.mtimeMs < RUN_WINDOW_MS) {
        await putFile(`runs/${f}`, file);
        continue;
      }
      const day = age.mtime.toISOString().slice(0, 10);
      const logs = days.get(day) ?? [];
      logs.push({ path: f, size: age.size });
      days.set(day, logs);
    }
    // Only one bundle's logs are in memory at a time.
    for (const day of [...days.keys()].sort()) {
      const chunks: { path: string; size: number }[][] = [[]];
      let held = 0;
      for (const entry of days.get(day)!) {
        if (held > 0 && held + entry.size > BUNDLE_BYTES) {
          chunks.push([]);
          held = 0;
        }
        chunks.at(-1)!.push(entry);
        held += entry.size;
      }
      for (const [n, chunk] of chunks.entries()) {
        const bodies: { path: string; body: Uint8Array }[] = [];
        for (const l of chunk) {
          const f = Bun.file(join(runsDir, l.path));
          if (await f.exists())
            bodies.push({ path: l.path, body: new Uint8Array(await f.arrayBuffer()) });
        }
        if (bodies.length > 0)
          await put(
            `runs/${day}${n === 0 ? "" : `-${n + 1}`}.ndjson.zst`,
            packRuns(bodies),
          );
      }
    }

    await drain();

    const manifest: Manifest = {
      name,
      startedAt: at.toISOString(),
      finishedAt: new Date().toISOString(),
      version: forge.version,
      repos: bundled,
      apps: kept,
      files,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      ...(dbCounts === undefined ? {} : { counts: dbCounts }),
      key,
      packed,
    };
    await store.put(
      `${prefix}manifest.json`,
      JSON.stringify(manifest, null, 2),
    );
    finished = true;
    await writing;
    await store.delete(prefix + JOURNAL).catch(() => {});
    log.info("snapshot taken", {
      resumed: before.size,
      name,
      where: store.where,
      repos: bundled,
      apps: kept,
      files: files.length,
      key,
      mb: (manifest.bytes / 1_048_576).toFixed(1),
    });
    return manifest;
  } finally {
    clearInterval(ticker);
    clearInterval(journalTicker);
    // Puts still running when one failed must not outlive the scratch.
    await Promise.allSettled([...pending]);
    if (!finished && journal.size > 0) writeJournal();
    await writing;
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

/**
 * Delete every snapshot past the newest `keep`, and every prefix a release
 * cut short that nothing will resume: one with no manifest that is older
 * than the newest whole snapshot, or began more than a resume window ago.
 * Returns what went.
 */
export async function pruneSnapshots(
  store: Store,
  keep = KEEP,
  now = Date.now(),
): Promise<string[]> {
  const names = (await store.names(SNAPSHOT_PREFIX)).sort().reverse();
  const whole: string[] = [];
  const cut: string[] = [];
  for (const name of names)
    ((await store.get(`${SNAPSHOT_PREFIX}${name}/manifest.json`)) === undefined ? cut : whole).push(name);
  const newest = whole[0];
  const stale = cut.filter((name) => {
    const at = snapshotStart(name);
    if (at === undefined) return false;
    return (newest !== undefined && name < newest) || now - at.getTime() > RESUME_WINDOW_MS;
  });
  const gone = [...whole.slice(keep), ...stale];
  for (const name of gone)
    for (const key of await store.list(`${SNAPSHOT_PREFIX}${name}/`))
      await store.delete(key);
  if (gone.length > 0)
    log.info("snapshots pruned", { gone: gone.length, kept: keep });
  return gone;
}
