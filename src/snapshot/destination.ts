/**
 * Where snapshots go, decided in one place. The nightly snapshot, the
 * button, the test and the restore command all ask `resolveDestination`;
 * none reads `S3_*` itself. Precedence: the destination sealed in this
 * forge (set on the Backups page) wins, then `FORGE_SNAPSHOT_DIR`, then
 * the `S3_*` variables a host-provisioned forge is given.
 *
 * The sealed settings are forge-level secrets, opened only through
 * `resolveSecrets`, so every open is audited and no value is ever read back
 * to a page. Pure apart from that.
 */

import type { Database } from "bun:sqlite";
import type { EventBus } from "../core/events.ts";
import { deleteSecret, resolveSecrets } from "../core/secret_store.ts";
import {
  dirStore,
  s3FromEnv,
  s3Store,
  type S3Target,
  type Store,
} from "./store.ts";

export type DestinationSource = "sealed" | "dir" | "env";

export interface Destination {
  readonly source: DestinationSource;
  readonly store: Store;
}

/** The sealed names, one per field of the form. */
export const SEALED = {
  endpoint: "SNAPSHOT_S3_ENDPOINT",
  bucket: "SNAPSHOT_S3_BUCKET",
  region: "SNAPSHOT_S3_REGION",
  accessKey: "SNAPSHOT_S3_ACCESS_KEY",
  secretKey: "SNAPSHOT_S3_SECRET_KEY",
} as const;
export const SEALED_NAMES: readonly string[] = Object.values(SEALED);

export interface Sources {
  readonly db?: Database | undefined;
  readonly dataDir?: string | undefined;
  readonly bus?: EventBus | undefined;
  readonly env?: Record<string, string | undefined>;
  /** Tries per store call; a status read asks for one so a dead store answers at once, not after the backoff. */
  readonly attempts?: number;
}

/** The sealed target, or undefined when the four required fields are not all set. */
export function sealedTarget(s: Sources): S3Target | undefined {
  if (!s.db || s.dataDir === undefined || !s.bus) return undefined;
  const v = resolveSecrets(s.db, s.dataDir, s.bus, SEALED_NAMES, {});
  const endpoint = v[SEALED.endpoint];
  const bucket = v[SEALED.bucket];
  const accessKeyId = v[SEALED.accessKey];
  const secretAccessKey = v[SEALED.secretKey];
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    return undefined;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: v[SEALED.region],
  };
}

export function resolveDestination(s: Sources = {}): Destination | undefined {
  const env = s.env ?? process.env;
  const sealed = sealedTarget(s);
  if (sealed) return { source: "sealed", store: s3Store(sealed, s.attempts) };
  const dir = env["FORGE_SNAPSHOT_DIR"]?.trim();
  if (dir) return { source: "dir", store: dirStore(dir) };
  const fromEnv = s3FromEnv(env);
  if (fromEnv) return { source: "env", store: s3Store(fromEnv, s.attempts) };
  return undefined;
}

/** Which of the sealed names are set, without opening any. */
export function sealedSet(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM secret WHERE scope = 'forge' AND scope_id = ''
       AND name LIKE 'SNAPSHOT\\_S3\\_%' ESCAPE '\\'`,
    )
    .all()
    .map((r) => r.name);
}

/** Forget the sealed destination; the environment's, if any, takes over. */
export function clearSealed(db: Database): void {
  for (const name of SEALED_NAMES) deleteSecret(db, "forge", "", name);
}

/** An error as one short sentence: the target's keys struck out, at most 200 characters. */
export function scrubReason(target: S3Target | undefined, error: unknown): string {
  let reason = error instanceof Error ? error.message : String(error);
  for (const secret of target ? [target.accessKeyId, target.secretAccessKey] : [])
    if (secret) reason = reason.split(secret).join("…");
  // One line: a store's message may end in a newline or carry an empty name between spaces.
  return reason.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Does this target answer? One sentence either way, never a key in it. */
export async function testTarget(target: S3Target): Promise<string> {
  // One attempt: a test that retries a refused port makes the answer wait on backoff.
  const store = s3Store(target, 1);
  try {
    const keys = await store.list("");
    return `Reached ${store.where}: ${keys.length === 1 ? "1 object" : `${keys.length} objects`} listed.`;
  } catch (error) {
    return `Could not list ${store.where}: ${scrubReason(target, error)}`;
  }
}
