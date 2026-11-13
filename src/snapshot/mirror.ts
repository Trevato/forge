/**
 * The off-box mirror: a second S3-compatible bucket (Backblaze B2, say) that
 * every snapshot is copied to, so losing the machine does not lose the
 * snapshots with it. It is the forge's off-site backup lane (#11805): the
 * pass runs in the forge's own process, and with the operator's passphrase
 * every object it writes is sealed (`sealed_store.ts`). Its keys are sealed in the forge like the Backups
 * destination (`SNAPSHOT_MIRROR_S3_*`), or given as `FORGE_MIRROR_S3_*`.
 *
 * A pass copies each of the newest snapshots the mirror lacks, the manifest
 * last, so a half-copied snapshot is never listed; objects already there are
 * skipped, so a pass that died resumes. What the last pass found is kept in
 * one small file under the data directory (`mirror/state.json`), so the
 * board and the push read it without touching the network. Plain data in,
 * plain data out.
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "../core/events.ts";
import { deleteSecret, resolveSecrets } from "../core/secret_store.ts";
import { KEEP, listSnapshots, pruneSnapshots, SNAPSHOT_PREFIX } from "./snapshot.ts";
import { refusingStore, sealedStore } from "./sealed_store.ts";
import { s3Store, type S3Target, type Store } from "./store.ts";

/** The sealed names, one per field of the form. */
export const MIRROR_SEALED = {
  endpoint: "SNAPSHOT_MIRROR_S3_ENDPOINT",
  bucket: "SNAPSHOT_MIRROR_S3_BUCKET",
  region: "SNAPSHOT_MIRROR_S3_REGION",
  accessKey: "SNAPSHOT_MIRROR_S3_ACCESS_KEY",
  secretKey: "SNAPSHOT_MIRROR_S3_SECRET_KEY",
} as const;
export const MIRROR_NAMES: readonly string[] = Object.values(MIRROR_SEALED);

/** A mirror not confirmed in sync for this long is one line on the board. */
export const MIRROR_STALE_MS = 24 * 3_600_000;
/** How often the forge looks for snapshots the mirror lacks. */
export const MIRROR_EVERY_MS = 3_600_000;
/** Objects copied at once: each is held in memory while it moves. */
const COPY_AT_ONCE = 4;

export interface MirrorSources {
  readonly db?: Database | undefined;
  readonly dataDir?: string | undefined;
  readonly bus?: EventBus | undefined;
  readonly env?: Record<string, string | undefined>;
  /** The operator's passphrase: given, every object the mirror holds is sealed under it (#11805). */
  readonly passphrase?: string | undefined;
}

export interface Mirror {
  readonly source: "sealed" | "env";
  readonly store: Store;
  /** Whether what lands there is encrypted; without a passphrase nothing lands, and `/system` says why. */
  readonly encrypted: boolean;
}

/** The mirror's target: sealed in this forge, else `FORGE_MIRROR_S3_*`; undefined when neither is whole. */
export function mirrorTarget(s: MirrorSources = {}): { source: Mirror["source"]; target: S3Target } | undefined {
  if (s.db && s.dataDir !== undefined && s.bus) {
    const v = resolveSecrets(s.db, s.dataDir, s.bus, MIRROR_NAMES, {});
    const endpoint = v[MIRROR_SEALED.endpoint];
    const bucket = v[MIRROR_SEALED.bucket];
    const accessKeyId = v[MIRROR_SEALED.accessKey];
    const secretAccessKey = v[MIRROR_SEALED.secretKey];
    if (endpoint && bucket && accessKeyId && secretAccessKey)
      return {
        source: "sealed",
        target: { endpoint, bucket, accessKeyId, secretAccessKey, region: v[MIRROR_SEALED.region] },
      };
  }
  const env = s.env ?? process.env;
  const endpoint = env["FORGE_MIRROR_S3_ENDPOINT"]?.trim();
  const bucket = env["FORGE_MIRROR_S3_BUCKET"]?.trim();
  const accessKeyId = env["FORGE_MIRROR_S3_ACCESS_KEY"]?.trim();
  const secretAccessKey = env["FORGE_MIRROR_S3_SECRET_KEY"]?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  return {
    source: "env",
    target: { endpoint, bucket, accessKeyId, secretAccessKey, region: env["FORGE_MIRROR_S3_REGION"]?.trim() || undefined },
  };
}

/** Said by every call of a lane with no passphrase: the board shows it, and nothing is written. */
export const NO_PASSPHRASE = "FORGE_SNAPSHOT_PASSPHRASE is not set, so the off-site lane writes nothing";

/**
 * The lane as the forge writes it: sealed under the passphrase. Without one
 * it fails closed (#11805): a store that refuses every call, so not one
 * unsealed byte leaves and each pass fails saying why.
 */
export function resolveMirror(s: MirrorSources = {}, options: { create?: boolean } = {}): Mirror | undefined {
  const t = mirrorTarget(s);
  if (t === undefined) return undefined;
  const plain = s3Store(t.target);
  return s.passphrase
    ? { source: t.source, store: sealedStore(plain, s.passphrase, options), encrypted: true }
    : { source: t.source, store: refusingStore(plain.where, NO_PASSPHRASE), encrypted: false };
}

/** Which of the sealed mirror names are set, without opening any. */
export function mirrorSealedSet(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM secret WHERE scope = 'forge' AND scope_id = ''
       AND name LIKE 'SNAPSHOT\\_MIRROR\\_S3\\_%' ESCAPE '\\'`,
    )
    .all()
    .map((r) => r.name);
}

export function clearMirrorSealed(db: Database): void {
  for (const name of MIRROR_NAMES) deleteSecret(db, "forge", "", name);
}

export interface MirrorState {
  readonly where: string;
  /** When the last pass began. */
  readonly attemptAt: string;
  /** Whether the last pass could list the mirror. */
  readonly reachable: boolean;
  /** The last time the mirror was confirmed to hold the newest snapshot. */
  readonly syncedAt?: string;
  /** The newest snapshot the mirror holds, and when it finished. */
  readonly newest?: string;
  readonly newestAt?: string;
  /** Set while passes are failing: since when, which snapshot, and why. */
  readonly failingSince?: string;
  readonly failed?: string;
  readonly error?: string;
  /** Whether the mirror's objects are encrypted (`Store.sealed`); absent in states kept before #11805. */
  readonly sealed?: boolean;
  /** Set (and nothing recorded) when the primary, not the mirror, could not be read. */
  readonly sourceError?: string;
}

/** A failure on the primary side of a copy: the mirror is not to blame for it. */
class SourceError extends Error {}

/** The primary, with every failure marked as its own. */
function marked(src: Store): Store {
  const mark = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } catch (error) {
      throw new SourceError(error instanceof Error ? error.message : String(error));
    }
  };
  return { ...src, where: src.where, get: mark(src.get.bind(src)), list: mark(src.list.bind(src)), names: mark(src.names.bind(src)) };
}

const stateFile = (dataDir: string): string => join(dataDir, "mirror", "state.json");

export function recordMirror(dataDir: string, state: MirrorState | undefined): void {
  if (state === undefined) {
    rmSync(stateFile(dataDir), { force: true });
    return;
  }
  mkdirSync(join(dataDir, "mirror"), { recursive: true });
  const tmp = `${stateFile(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, stateFile(dataDir));
}

/** What the last pass found; undefined when no mirror has been tried or the file is not one. */
export function lastMirror(dataDir: string): MirrorState | undefined {
  try {
    const s = JSON.parse(readFileSync(stateFile(dataDir), "utf8")) as MirrorState;
    if (typeof s.where !== "string" || typeof s.attemptAt !== "string" || typeof s.reachable !== "boolean")
      return undefined;
    return s;
  } catch {
    return undefined;
  }
}

async function copyOne(src: Store, dst: Store, name: string): Promise<void> {
  const prefix = `${SNAPSHOT_PREFIX}${name}/`;
  const manifest = `${prefix}manifest.json`;
  const have = new Set(await dst.list(prefix));
  const listed = (await src.list(prefix)).filter((k) => k !== manifest);
  const stored = await Promise.all(listed.map((k) => dst.storedKey?.(k) ?? k));
  const todo = listed.filter((_, i) => !have.has(stored[i]!));
  for (let i = 0; i < todo.length; i += COPY_AT_ONCE)
    await Promise.all(
      todo.slice(i, i + COPY_AT_ONCE).map(async (key) => {
        const body = await src.get(key);
        if (body === undefined) throw new Error(`${key} vanished from the source`);
        await dst.put(key, body);
      }),
    );
  const body = await src.get(manifest);
  if (body === undefined) throw new Error(`${manifest} vanished from the source`);
  await dst.put(manifest, body);
}

/**
 * One pass: bring the mirror level with the source, prune it to `keep`, and
 * keep what came of it. Never throws; a failure is the returned state.
 */
export async function mirrorPass(
  dataDir: string,
  primary: Store,
  dst: Store,
  options: { now?: number; keep?: number } = {},
): Promise<MirrorState> {
  const now = options.now ?? Date.now();
  const keep = options.keep ?? KEEP;
  const at = new Date(now).toISOString();
  const src = marked(primary);
  const prev = lastMirror(dataDir);
  let reachable = false;
  let failed: string | undefined;
  let state: MirrorState;
  try {
    const names = new Set(await dst.names(SNAPSHOT_PREFIX));
    reachable = true;
    const wanted = (await listSnapshots(src)).slice(0, keep);
    for (const m of [...wanted].reverse()) {
      if (names.has(m.name) && (await dst.get(`${SNAPSHOT_PREFIX}${m.name}/manifest.json`)) !== undefined)
        continue;
      failed = m.name;
      await copyOne(src, dst, m.name);
      failed = undefined;
    }
    await pruneSnapshots(dst, keep);
    const newest = wanted[0];
    state = {
      where: dst.where,
      attemptAt: at,
      reachable: true,
      sealed: dst.sealed === true,
      syncedAt: at,
      ...(newest === undefined ? {} : { newest: newest.name, newestAt: newest.finishedAt }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof SourceError) {
      // The primary is down: the destination has its own line, and nothing
      // here says the mirror failed. What was recorded stands.
      return { ...(prev ?? { where: dst.where, attemptAt: at, reachable }), sourceError: reason.slice(0, 200) };
    }
    state = {
      where: dst.where,
      attemptAt: at,
      reachable,
      sealed: dst.sealed === true,
      ...(prev?.syncedAt === undefined ? {} : { syncedAt: prev.syncedAt }),
      ...(prev?.newest === undefined ? {} : { newest: prev.newest }),
      ...(prev?.newestAt === undefined ? {} : { newestAt: prev.newestAt }),
      failingSince: prev?.failingSince ?? at,
      ...(failed === undefined ? {} : { failed }),
      error: reason.slice(0, 200),
    };
  }
  try {
    recordMirror(dataDir, state);
  } catch {
    // A disk that will not take the file must not turn a copied snapshot into a failure.
  }
  return state;
}

export interface MirrorNeed {
  /** Holds as long as the same cause does: a new failure or a new silence is a new key. */
  readonly key: string;
  readonly sentence: string;
  readonly since: string;
}

/**
 * The one line the mirror owes the board: a pass that failed (the store
 * unreachable, or a snapshot that did not land), or a mirror not confirmed
 * in sync for a day. A mirror in sync: none.
 */
export function mirrorNeed(s: MirrorState | undefined, now: number): MirrorNeed | undefined {
  if (s === undefined) return undefined;
  if (s.failingSince !== undefined)
    return {
      key: `fail:${s.failingSince}`,
      sentence: s.error === NO_PASSPHRASE
        ? `The off-box mirror ${s.where} writes nothing: set FORGE_SNAPSHOT_PASSPHRASE.`
        : s.reachable
        ? `Snapshot ${s.failed ?? "(unknown)"} did not land on the off-box mirror ${s.where}: ${s.error ?? "unknown reason"}.`
        : `The off-box mirror ${s.where} is unreachable: ${s.error ?? "unknown reason"}.`,
      since: s.failingSince,
    };
  const at = Date.parse(s.syncedAt ?? "");
  if (Number.isFinite(at) && now - at <= MIRROR_STALE_MS) return undefined;
  return {
    key: `stale:${s.syncedAt ?? s.attemptAt}`,
    sentence: `The off-box mirror ${s.where} has not been confirmed in sync for over a day${s.syncedAt ? `; last on ${s.syncedAt.slice(0, 10)}` : ""}.`,
    since: s.syncedAt ? new Date(at + MIRROR_STALE_MS).toISOString() : s.attemptAt,
  };
}

/**
 * The off-site lane as a restore on a fresh machine reads it (#11805): from
 * the environment alone (`FORGE_MIRROR_S3_*`), and sealed, so the
 * passphrase is required. A sentence when either is missing.
 */
export function offsiteFromEnv(env: Record<string, string | undefined> = process.env): Store | string {
  const passphrase = env["FORGE_SNAPSHOT_PASSPHRASE"] || undefined;
  // A restore reads: an empty bucket is said, never started as a new lane.
  const m = resolveMirror({ env, passphrase }, { create: false });
  if (m === undefined)
    return "no off-site lane: export FORGE_MIRROR_S3_ENDPOINT, FORGE_MIRROR_S3_BUCKET, FORGE_MIRROR_S3_ACCESS_KEY and FORGE_MIRROR_S3_SECRET_KEY";
  if (passphrase === undefined) return "the off-site lane is sealed: export FORGE_SNAPSHOT_PASSPHRASE";
  return m.store;
}
