/**
 * Where snapshots go. Two places, one shape: a bucket over S3 (the platform
 * gives every app one, mirrored off the machine by lanes the forge never
 * sees) or a directory (a forge on a desk, a test). Keys are paths; the
 * store keeps no other idea of structure, so a snapshot is exactly the
 * files it lists and a restore is exactly reading them back.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface Store {
  /** What this store is, for a page and a log; never a secret. */
  readonly where: string;
  /** The directory it writes under, when it is one; a bucket has none. */
  readonly dir?: string;
  put(key: string, body: Uint8Array | string): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  /** Every key under `prefix`, in no particular order. */
  list(prefix: string): Promise<string[]>;
  /** The next path segment under `prefix`: the "directories", not the keys. */
  names(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** The S3 credentials as the platform hands them to an app. */
export interface S3Target {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string | undefined;
}

/** Read the platform's `S3_*` variables; undefined when the app has no bucket. */
export function s3FromEnv(
  env: Record<string, string | undefined> = process.env,
): S3Target | undefined {
  const endpoint = env["S3_ENDPOINT"]?.trim();
  const bucket = env["S3_BUCKET"]?.trim();
  const accessKeyId = env["S3_ACCESS_KEY"]?.trim();
  const secretAccessKey = env["S3_SECRET_KEY"]?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    return undefined;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env["S3_REGION"]?.trim() || undefined,
  };
}

/**
 * A store that tries again. Object stores answer a burst, a flake or a
 * moment of maintenance with a 5xx — Backblaze says so in its own docs —
 * and one such answer in a thousand puts used to fail the whole snapshot
 * with "S3Error: an unexpected error has occurred" and no key named. Every
 * call is tried `attempts` times with doubling waits, and what finally
 * fails says which key it was. An attempt that has not answered within
 * `deadlineMs` counts as failed too: a connection that died quietly never
 * settles on its own, and once held a snapshot on its first object for an
 * hour with the network fine (2026-10-13), so the next attempt opens a
 * fresh request instead.
 */
export function withRetries(
  inner: Store,
  options: {
    attempts?: number;
    baseMs?: number;
    deadlineMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Store {
  const attempts = Math.max(1, options.attempts ?? 5);
  const baseMs = options.baseMs ?? 500;
  const deadlineMs = options.deadlineMs ?? 180_000;
  const sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  async function tried<T>(what: string, fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let n = 0; n < attempts; n++) {
      try {
        return await answered(fn(), deadlineMs);
      } catch (error) {
        last = error;
        if (n + 1 < attempts) await sleep(baseMs * 2 ** n);
      }
    }
    throw new Error(
      `${what} failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${String(last instanceof Error ? last.message : last)}`,
    );
  }
  return {
    where: inner.where,
    ...(inner.dir === undefined ? {} : { dir: inner.dir }),
    put: (key, body) => tried(`put ${key}`, () => inner.put(key, body)),
    get: (key) => tried(`get ${key}`, () => inner.get(key)),
    list: (prefix) => tried(`list ${prefix}`, () => inner.list(prefix)),
    names: (prefix) => tried(`names ${prefix}`, () => inner.names(prefix)),
    delete: (key) => tried(`delete ${key}`, () => inner.delete(key)),
  };
}

/**
 * The attempt's answer, or a rejection once `ms` have passed without one.
 * The abandoned attempt is left to settle on its own, its outcome ignored.
 */
function answered<T>(attempt: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const shown = ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${shown}`)), ms);
  });
  attempt.catch(() => {});
  return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer));
}

export function s3Store(target: S3Target): Store {
  return withRetries(rawS3Store(target));
}

function rawS3Store(target: S3Target): Store {
  const client = new Bun.S3Client({
    endpoint: target.endpoint,
    bucket: target.bucket,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    ...(target.region === undefined ? {} : { region: target.region }),
  });
  return {
    where: `${target.endpoint.replace(/^https?:\/\//, "")}/${target.bucket}`,
    async put(key, body) {
      await client.write(key, body);
    },
    async get(key) {
      const file = client.file(key);
      if (!(await file.exists())) return undefined;
      return new Uint8Array(await file.arrayBuffer());
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.list({
          prefix,
          maxKeys: 1000,
          ...(token === undefined ? {} : { continuationToken: token }),
        });
        for (const item of page.contents ?? []) keys.push(item.key);
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token !== undefined);
      return keys;
    },
    async names(prefix) {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.list({
          prefix,
          delimiter: "/",
          maxKeys: 1000,
          ...(token === undefined ? {} : { continuationToken: token }),
        });
        for (const p of page.commonPrefixes ?? [])
          out.push(p.prefix.slice(prefix.length).replace(/\/$/, ""));
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token !== undefined);
      return out;
    },
    async delete(key) {
      await client.delete(key);
    },
  };
}

/** A directory as a store: `key` is a path under it, nothing else. */
export function dirStore(root: string): Store {
  const at = (key: string): string => {
    if (key.startsWith("/") || key.split("/").includes(".."))
      throw new Error(`refusing key ${key}`);
    return join(root, key);
  };
  const walk = (dir: string, out: string[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else out.push(relative(root, path));
    }
  };
  return {
    where: root,
    dir: root,
    async put(key, body) {
      const path = at(key);
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, body);
    },
    async get(key) {
      const file = Bun.file(at(key));
      if (!(await file.exists())) return undefined;
      return new Uint8Array(await file.arrayBuffer());
    },
    async list(prefix) {
      const all: string[] = [];
      walk(root, all);
      return all.filter((k) => k.startsWith(prefix));
    },
    async names(prefix) {
      try {
        return readdirSync(at(prefix)).filter((n) =>
          statSync(join(at(prefix), n)).isDirectory(),
        );
      } catch {
        return [];
      }
    },
    async delete(key) {
      rmSync(at(key), { force: true });
    },
  };
}
